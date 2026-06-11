//! Terminal client for evosim-server. Pairs with the web demo:
//! connects to the same WebSocket / msgpack protocol, but renders
//! into the terminal via ratatui.
//!
//! Layout:
//!   ┌─ status ──────────────────────────────────────────────┐
//!   │ t=… cells=… species=… mass=… light=…                  │
//!   ├─ map ──────────────────────────┬─ species ────────────┤
//!   │ ASCII grid of cell positions   │ ranked list with     │
//!   │ (one char per cell)            │ count / mass / atp   │
//!   │                                │                      │
//!   └────────────────────────────────┴──────────────────────┘
//!
//! Keys: q = quit, p = pause, r = resume, [/]/-/+ = sim rate down/up,
//! n = save.

use anyhow::{Context, Result};
use clap::Parser;
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use evosim_protocol::{
    decode_server, encode_client, AdminCommand, ClientMessage, ServerMessage, Snapshot,
    SpeciesSummary,
};
use futures_util::{SinkExt, StreamExt};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;
use std::io::stdout;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Parser, Debug)]
#[command(name = "evosim-tui", about = "Terminal client for evosim-server")]
struct Cli {
    /// WebSocket URL of the evosim-server.
    #[arg(long, default_value = "ws://127.0.0.1:8080/sim")]
    url: String,
    /// Admin bearer token. Lets save/restart/configure work.
    #[arg(long, env = "EVOSIM_ADMIN_TOKEN")]
    token: Option<String>,
}

#[derive(Default)]
struct UiState {
    last_snapshot: Option<Snapshot>,
    last_snapshot_at: Option<Instant>,
    running: bool,
    sim_rate: f32,
    status_line: String,
    admin: bool,
    connected: bool,
    err: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let ui = Arc::new(Mutex::new(UiState {
        running: true,
        sim_rate: 1.0,
        connected: false,
        ..UiState::default()
    }));

    // Connect to the server.
    let (ws, _) = connect_async(&cli.url)
        .await
        .with_context(|| format!("connecting to {}", cli.url))?;
    {
        let mut u = ui.lock().await;
        u.connected = true;
    }
    let (mut write, mut read) = ws.split();

    // Auth (sends token if we have one; server sends a second Hello
    // with admin=true if accepted).
    if cli.token.is_some() {
        let auth = ClientMessage::Auth { token: cli.token.clone() };
        write
            .send(Message::Binary(encode_client(&auth)?))
            .await
            .context("send auth")?;
    }

    // Spawn reader task: decode frames, update state.
    let read_ui = ui.clone();
    let reader = tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            let bytes = match msg {
                Ok(Message::Binary(b)) => b,
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            };
            let Ok(decoded) = decode_server(&bytes) else {
                continue;
            };
            let mut u = read_ui.lock().await;
            match decoded {
                ServerMessage::Hello {
                    capabilities,
                    build,
                    protocol,
                    ..
                } => {
                    u.admin = capabilities.admin;
                    u.status_line = format!(
                        "evosim-tui connected: protocol={} build={} admin={}",
                        protocol, build.commit, capabilities.admin
                    );
                }
                ServerMessage::Snapshot(s) => {
                    u.last_snapshot = Some(s);
                    u.last_snapshot_at = Some(Instant::now());
                }
                ServerMessage::AdminAck { command, message } => {
                    u.status_line =
                        format!("ack[{command}] {}", message.unwrap_or_default());
                }
                ServerMessage::AdminNack { command, reason } => {
                    u.status_line = format!("nack[{command}] {reason}");
                }
                ServerMessage::Error { code, message } => {
                    u.err = Some(format!("{code}: {message}"));
                }
                ServerMessage::Goodbye { reason } => {
                    u.status_line = format!("server goodbye: {reason}");
                    break;
                }
            }
        }
        let mut u = read_ui.lock().await;
        u.connected = false;
    });

    // Wrap write in an Arc<Mutex> so the key-handler can also send.
    let writer = Arc::new(Mutex::new(write));

    // Init terminal.
    enable_raw_mode().context("raw mode")?;
    let mut out = stdout();
    out.execute(EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(out);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let res = run_loop(&mut terminal, ui.clone(), writer.clone()).await;

    // Restore terminal.
    disable_raw_mode().ok();
    terminal.backend_mut().execute(LeaveAlternateScreen).ok();
    terminal.show_cursor().ok();
    reader.abort();
    res
}

async fn run_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    ui: Arc<Mutex<UiState>>,
    writer: Arc<Mutex<futures_util::stream::SplitSink<Ws, Message>>>,
) -> Result<()> {
    let tick = Duration::from_millis(100);
    loop {
        // Drain key events (non-blocking).
        let mut should_quit = false;
        while event::poll(Duration::from_millis(0))? {
            if let Event::Key(k) = event::read()? {
                if k.modifiers.contains(KeyModifiers::CONTROL)
                    && (k.code == KeyCode::Char('c') || k.code == KeyCode::Char('d'))
                {
                    should_quit = true;
                    break;
                }
                match k.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        should_quit = true;
                        break;
                    }
                    KeyCode::Char('p') => {
                        send_msg(&writer, &ClientMessage::SetRunning { running: false }).await?;
                        ui.lock().await.running = false;
                    }
                    KeyCode::Char('r') => {
                        send_msg(&writer, &ClientMessage::SetRunning { running: true }).await?;
                        ui.lock().await.running = true;
                    }
                    KeyCode::Char(']') | KeyCode::Char('+') | KeyCode::Char('=') => {
                        let mut u = ui.lock().await;
                        u.sim_rate = (u.sim_rate * 2.0).min(8.0);
                        let r = u.sim_rate;
                        drop(u);
                        send_msg(&writer, &ClientMessage::SetSimRate { rate: r }).await?;
                    }
                    KeyCode::Char('[') | KeyCode::Char('-') => {
                        let mut u = ui.lock().await;
                        u.sim_rate = (u.sim_rate / 2.0).max(0.0625);
                        let r = u.sim_rate;
                        drop(u);
                        send_msg(&writer, &ClientMessage::SetSimRate { rate: r }).await?;
                    }
                    KeyCode::Char('s') => {
                        let name = format!(
                            "tui-{}",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0)
                        );
                        send_msg(
                            &writer,
                            &ClientMessage::Save { name: Some(name) },
                        )
                        .await?;
                    }
                    KeyCode::Char('x') => {
                        send_msg(
                            &writer,
                            &ClientMessage::Admin {
                                command: AdminCommand::Reset,
                            },
                        )
                        .await?;
                    }
                    _ => {}
                }
            }
        }
        if should_quit {
            break Ok(());
        }

        // Render.
        let u = ui.lock().await.clone_view();
        terminal.draw(|f| render(f, &u))?;

        tokio::time::sleep(tick).await;
    }
}

async fn send_msg(
    writer: &Arc<Mutex<futures_util::stream::SplitSink<Ws, Message>>>,
    msg: &ClientMessage,
) -> Result<()> {
    let bytes = encode_client(msg)?;
    let mut w = writer.lock().await;
    w.send(Message::Binary(bytes)).await?;
    Ok(())
}

/// Render-time snapshot of UI state. Cheap clone so we don't hold
/// the lock across terminal.draw.
#[derive(Default, Clone)]
struct UiView {
    last_snapshot: Option<Snapshot>,
    last_snapshot_at: Option<Instant>,
    running: bool,
    sim_rate: f32,
    status_line: String,
    admin: bool,
    connected: bool,
    err: Option<String>,
}

impl UiState {
    fn clone_view(&self) -> UiView {
        UiView {
            last_snapshot: self.last_snapshot.clone(),
            last_snapshot_at: self.last_snapshot_at,
            running: self.running,
            sim_rate: self.sim_rate,
            status_line: self.status_line.clone(),
            admin: self.admin,
            connected: self.connected,
            err: self.err.clone(),
        }
    }
}

fn render(f: &mut ratatui::Frame<'_>, u: &UiView) {
    let area = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(0),
            Constraint::Length(3),
        ])
        .split(area);
    render_status(f, chunks[0], u);
    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(0), Constraint::Length(48)])
        .split(chunks[1]);
    render_map(f, body[0], u);
    render_species(f, body[1], u);
    render_help(f, chunks[2], u);
}

fn render_status(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let title = if u.connected {
        "evosim-tui (connected)"
    } else {
        "evosim-tui (disconnected)"
    };
    let block = Block::default().borders(Borders::ALL).title(title);

    let text = if let Some(s) = &u.last_snapshot {
        let day_phase = if s.ambient_light > 0.5 {
            "🌞"
        } else if s.ambient_light > 0.0 {
            "🌅"
        } else {
            "🌙"
        };
        let mass = s.mass.total;
        let bonds = s.bonds.len() / 2;
        let admin = if u.admin { " [admin]" } else { "" };
        let running = if u.running { " >" } else { " ||" };
        let lag = u
            .last_snapshot_at
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        format!(
            "t={t:.0}s tick={tick} {day} light={light:.2} | cells={cells} species={species} bonds={bonds} parts={parts} mass={mass:.0} | rate={rate:.2}x{running}{admin} | lag={lag}ms",
            t = s.t,
            tick = s.tick,
            day = day_phase,
            light = s.ambient_light,
            cells = s.creatures.count,
            species = s.species_count,
            bonds = bonds,
            parts = s.particles.count,
            mass = mass,
            rate = u.sim_rate,
        )
    } else if let Some(e) = &u.err {
        format!("error: {e}")
    } else {
        u.status_line.clone()
    };
    let p = Paragraph::new(text).block(block);
    f.render_widget(p, area);
}

fn render_map(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let block = Block::default().borders(Borders::ALL).title("world");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let Some(s) = &u.last_snapshot else { return };
    if s.creatures.count == 0 || inner.width == 0 || inner.height == 0 {
        return;
    }

    // Build a char grid. We render with two world cells per
    // terminal cell horizontally to roughly match aspect ratio of
    // typical terminal cells (~1:2 w:h).
    let grid_w = inner.width as usize;
    let grid_h = inner.height as usize;
    let mut grid: Vec<Vec<char>> = vec![vec![' '; grid_w]; grid_h];

    let xb = s
        .creatures
        .blobs
        .iter()
        .find(|b| b.name == "x")
        .map(|b| as_f32(&b.data));
    let yb = s
        .creatures
        .blobs
        .iter()
        .find(|b| b.name == "y")
        .map(|b| as_f32(&b.data));
    let sb = s
        .creatures
        .blobs
        .iter()
        .find(|b| b.name == "speciesIdx")
        .map(|b| b.data.clone());

    if let (Some(xs), Some(ys), Some(sids)) = (xb, yb, sb) {
        for i in 0..(s.creatures.count as usize) {
            let x = xs[i];
            let y = ys[i];
            let cx = ((x / s.width) * grid_w as f32) as usize;
            let cy = ((y / s.height) * grid_h as f32) as usize;
            let cx = cx.min(grid_w.saturating_sub(1));
            let cy = cy.min(grid_h.saturating_sub(1));
            let species_char = species_glyph(sids.get(i).copied().unwrap_or(0xFF));
            grid[cy][cx] = species_char;
        }
    }
    let lines: Vec<Line<'static>> = grid
        .into_iter()
        .map(|row| Line::raw(row.into_iter().collect::<String>()))
        .collect();
    let p = Paragraph::new(lines);
    f.render_widget(p, inner);
}

fn species_glyph(species_idx: u8) -> char {
    // 0xFF means "outside top-N"; use '.'
    if species_idx == 0xFF {
        return '.';
    }
    // Distinct printable glyphs for the top 16 species.
    const GLYPHS: &[char] = &[
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
    ];
    GLYPHS[(species_idx as usize) % GLYPHS.len()]
}

fn render_species(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let block = Block::default().borders(Borders::ALL).title("species");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let Some(s) = &u.last_snapshot else { return };
    if s.top_species.is_empty() {
        return;
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(vec![
        Span::styled(
            "  glyph    count    mass     atp",
            Style::default().add_modifier(Modifier::BOLD),
        ),
    ]));
    for (i, sp) in s
        .top_species
        .iter()
        .enumerate()
        .take(inner.height.saturating_sub(1) as usize)
    {
        lines.push(format_species_line(i, sp));
    }
    let p = Paragraph::new(lines);
    f.render_widget(p, inner);
}

fn format_species_line(i: usize, sp: &SpeciesSummary) -> Line<'static> {
    let g = species_glyph(i as u8);
    let line = format!(
        "  {g}    {count:>4}  {mass:>7.0}  {atp:>6.0}",
        count = sp.count,
        mass = sp.biomass,
        atp = sp.atp,
    );
    let color = colour_for_glyph(i as u8);
    Line::from(vec![Span::styled(line, Style::default().fg(color))])
}

fn colour_for_glyph(i: u8) -> Color {
    match i % 8 {
        0 => Color::LightRed,
        1 => Color::LightGreen,
        2 => Color::LightYellow,
        3 => Color::LightBlue,
        4 => Color::LightMagenta,
        5 => Color::LightCyan,
        6 => Color::White,
        _ => Color::Gray,
    }
}

fn render_help(f: &mut ratatui::Frame<'_>, area: Rect, _u: &UiView) {
    let block = Block::default().borders(Borders::ALL).title("keys");
    let text = "q quit  p pause  r resume  ]/[ rate +/-  s save  x reset(admin)";
    let p = Paragraph::new(text).block(block);
    f.render_widget(p, area);
}

fn as_f32(bytes: &[u8]) -> Vec<f32> {
    let n = bytes.len() / 4;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&bytes[i * 4..i * 4 + 4]);
        out.push(f32::from_le_bytes(buf));
    }
    out
}
