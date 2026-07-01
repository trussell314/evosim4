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
use ratatui::widgets::{Block, Borders, Paragraph, Sparkline};
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

/// Number of history samples kept for the sparklines. At the
/// snapshot cadence (10 Hz on the server) 600 samples is ~ 60 sec
/// of recent state -- enough trajectory to see population trends
/// without scrolling the data.
const HISTORY_LEN: usize = 600;

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
    /// Rolling history rings for sparklines. Oldest at the front.
    history_cells: std::collections::VecDeque<u64>,
    history_species: std::collections::VecDeque<u64>,
    history_mass: std::collections::VecDeque<u64>,
    /// Rolling history of tick wall-time (ms * 1000 so we can use the
    /// u64-only Sparkline widget at sub-ms resolution).
    history_tick_us: std::collections::VecDeque<u64>,
    /// Rolling history of particle count -- the variable that drives
    /// per-tick cost the most. Sparkline alongside tick_us makes it
    /// obvious when a perf jump is from sheer particle inflation.
    history_particles: std::collections::VecDeque<u64>,
    /// Per-chem labels from the Hello frame. Index = chem id.
    chem_names: Vec<String>,
    /// Cursor into the top_species roster. j/k moves it; cells of the
    /// selected species get an arrow marker and the bottom-right panel
    /// shows the species' textual description.
    selected_species: usize,
    /// Bottom-right view toggle. False = history sparklines
    /// (cells / species / mass); true = perf breakdown (tick wall-
    /// time + particles + top-N pass cost). Toggled by `m`.
    perf_view: bool,
    /// Save-list popup. `None` when closed; `Some` after `L` has
    /// fetched the list. j/k navigates, Enter loads, Esc closes.
    save_list: Option<Vec<String>>,
    save_selected: usize,
    /// Cell-kill confirmation: `Some(species_idx)` means we sent a
    /// KillCell admin command targeting a cell of that species; the
    /// status bar reports the outcome.
    pending_kill_species: Option<usize>,
    /// Whether the help popup is open. Toggled by `?` and dismissed
    /// by any other key.
    show_help: bool,
}

impl UiState {
    fn push_history(&mut self, snap: &Snapshot) {
        if self.history_cells.len() >= HISTORY_LEN {
            self.history_cells.pop_front();
            self.history_species.pop_front();
            self.history_mass.pop_front();
            self.history_tick_us.pop_front();
            self.history_particles.pop_front();
        }
        self.history_cells.push_back(snap.creatures.count as u64);
        self.history_species.push_back(snap.species_count as u64);
        // Mass to u64 (sparkline wants u64). Total fits comfortably.
        self.history_mass.push_back(snap.mass.total.max(0.0) as u64);
        // tick_ms is stored in microseconds so the sparkline shows
        // sub-millisecond detail; integer-only widget can't take f32.
        self.history_tick_us
            .push_back((snap.perf.tick_ms * 1000.0).max(0.0) as u64);
        self.history_particles
            .push_back(snap.particles.count as u64);
    }
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
                    chem_names,
                    ..
                } => {
                    u.admin = capabilities.admin;
                    u.chem_names = chem_names;
                    u.status_line = format!(
                        "evosim-tui connected: protocol={} build={} admin={}",
                        protocol, build.commit, capabilities.admin
                    );
                }
                ServerMessage::Snapshot(s) => {
                    // Mirror server-wide truth so multiple clients
                    // agree on speed and pause state.
                    u.sim_rate = s.sim_rate;
                    u.running = s.running;
                    u.push_history(&s);
                    u.last_snapshot = Some(*s);
                    u.last_snapshot_at = Some(Instant::now());
                }
                ServerMessage::AdminAck { command, message } => {
                    let body = message.unwrap_or_default();
                    if command == "saves" {
                        // Payload is a JSON array of strings -- cheap
                        // hand-parse so we don't pull in serde_json
                        // just for this one shape.
                        u.save_list = Some(parse_json_string_array(&body));
                        u.save_selected = 0;
                        u.status_line = format!("saves ({})", u.save_list.as_ref().map(|v| v.len()).unwrap_or(0));
                    } else if command == "export" && !body.is_empty() {
                        // Write the world JSON to the cwd so the
                        // operator can grab it. Filename is timestamped
                        // so repeated exports don't overwrite.
                        let ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let path = format!("evosim-{ts}.json");
                        match std::fs::write(&path, &body) {
                            Ok(_) => u.status_line = format!("export -> {path} ({} bytes)", body.len()),
                            Err(e) => u.status_line = format!("export write failed: {e}"),
                        }
                    } else {
                        u.status_line = format!("ack[{command}] {body}");
                    }
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
                // TUI doesn't show per-cell chems yet; the message is
                // accepted to satisfy the match and silently dropped.
                ServerMessage::CellInfo { .. } => {}
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
                // Pop-up handling first: when the save-list dialog is
                // open, j/k/Enter/Esc are scoped to it rather than the
                // species roster.
                let popup_open = ui.lock().await.save_list.is_some();
                if popup_open {
                    match k.code {
                        KeyCode::Esc | KeyCode::Char('L') => {
                            ui.lock().await.save_list = None;
                            continue;
                        }
                        KeyCode::Char('j') | KeyCode::Down => {
                            let mut u = ui.lock().await;
                            if let Some(list) = u.save_list.as_ref() {
                                let n = list.len();
                                if n > 0 {
                                    u.save_selected = (u.save_selected + 1) % n;
                                }
                            }
                            continue;
                        }
                        KeyCode::Char('k') | KeyCode::Up => {
                            let mut u = ui.lock().await;
                            if let Some(list) = u.save_list.as_ref() {
                                let n = list.len();
                                if n > 0 {
                                    u.save_selected =
                                        if u.save_selected == 0 { n - 1 } else { u.save_selected - 1 };
                                }
                            }
                            continue;
                        }
                        KeyCode::Enter => {
                            let mut u = ui.lock().await;
                            let pick = u.save_list.as_ref().and_then(|list| {
                                list.get(u.save_selected.min(list.len().saturating_sub(1))).cloned()
                            });
                            u.save_list = None;
                            drop(u);
                            if let Some(name) = pick {
                                send_msg(
                                    &writer,
                                    &ClientMessage::Admin {
                                        command: AdminCommand::Load { name },
                                    },
                                )
                                .await?;
                            }
                            continue;
                        }
                        _ => {}
                    }
                }

                match k.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        should_quit = true;
                        break;
                    }
                    KeyCode::Char('p') | KeyCode::Char(' ') => {
                        // Toggle pause/run on a single key so muscle
                        // memory from the web client carries over.
                        let new_running = !ui.lock().await.running;
                        send_msg(&writer, &ClientMessage::SetRunning { running: new_running }).await?;
                        ui.lock().await.running = new_running;
                    }
                    KeyCode::Char('r') => {
                        send_msg(&writer, &ClientMessage::SetRunning { running: true }).await?;
                        ui.lock().await.running = true;
                    }
                    KeyCode::Char(']') | KeyCode::Char('+') | KeyCode::Char('=') => {
                        let mut u = ui.lock().await;
                        u.sim_rate = (u.sim_rate * 2.0).min(32.0);
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
                    KeyCode::Char('M') => {
                        // Snap to max sim rate.
                        ui.lock().await.sim_rate = 32.0;
                        send_msg(&writer, &ClientMessage::SetSimRate { rate: 32.0 }).await?;
                    }
                    KeyCode::Char('.') => {
                        // Single-tick step (server no-ops if running).
                        send_msg(&writer, &ClientMessage::Step).await?;
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
                    KeyCode::Char('j') | KeyCode::Down => {
                        let mut u = ui.lock().await;
                        let n = u
                            .last_snapshot
                            .as_ref()
                            .map(|s| s.top_species.len())
                            .unwrap_or(0);
                        if n > 0 {
                            u.selected_species = (u.selected_species + 1) % n;
                        }
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        let mut u = ui.lock().await;
                        let n = u
                            .last_snapshot
                            .as_ref()
                            .map(|s| s.top_species.len())
                            .unwrap_or(0);
                        if n > 0 {
                            u.selected_species =
                                if u.selected_species == 0 { n - 1 } else { u.selected_species - 1 };
                        }
                    }
                    KeyCode::Char('m') => {
                        let mut u = ui.lock().await;
                        u.perf_view = !u.perf_view;
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
                    KeyCode::Char('L') => {
                        // Fetches save list; reply lands in AdminAck
                        // handler and opens the popup.
                        send_msg(
                            &writer,
                            &ClientMessage::Admin {
                                command: AdminCommand::Saves,
                            },
                        )
                        .await?;
                    }
                    KeyCode::Char('?') => {
                        let mut u = ui.lock().await;
                        u.show_help = !u.show_help;
                    }
                    KeyCode::Char('E') => {
                        // Admin: export the world JSON. The AdminAck
                        // reply carries the body; the handler writes
                        // it to ./evosim-<ts>.json next to the cwd.
                        send_msg(
                            &writer,
                            &ClientMessage::Admin {
                                command: AdminCommand::Export,
                            },
                        )
                        .await?;
                    }
                    KeyCode::Char('X') => {
                        // Kill a cell of the currently-selected species
                        // (admin only). Looks up the first cell in the
                        // snapshot whose speciesIdx matches the cursor.
                        let target = {
                            let u = ui.lock().await;
                            cell_position_for_species(
                                u.last_snapshot.as_ref(),
                                u.selected_species,
                            )
                        };
                        if let Some((x, y)) = target {
                            send_msg(
                                &writer,
                                &ClientMessage::Admin {
                                    command: AdminCommand::KillCell { x, y },
                                },
                            )
                            .await?;
                            let mut u = ui.lock().await;
                            u.pending_kill_species = Some(u.selected_species);
                        } else {
                            ui.lock().await.status_line =
                                "no visible cell for selected species".into();
                        }
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
    history_cells: Vec<u64>,
    history_species: Vec<u64>,
    history_mass: Vec<u64>,
    history_tick_us: Vec<u64>,
    history_particles: Vec<u64>,
    chem_names: Vec<String>,
    selected_species: usize,
    /// "Perf" view toggle. False = the legacy cells/species/mass
    /// sparklines in the bottom-right; true = the perf breakdown
    /// (tick_us + particles sparklines on top, top-5 most expensive
    /// passes as a text list below). Toggled by the 'P' key.
    perf_view: bool,
    save_list: Option<Vec<String>>,
    save_selected: usize,
    show_help: bool,
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
            history_cells: self.history_cells.iter().copied().collect(),
            history_species: self.history_species.iter().copied().collect(),
            history_mass: self.history_mass.iter().copied().collect(),
            history_tick_us: self.history_tick_us.iter().copied().collect(),
            history_particles: self.history_particles.iter().copied().collect(),
            chem_names: self.chem_names.clone(),
            selected_species: self.selected_species,
            perf_view: self.perf_view,
            save_list: self.save_list.clone(),
            save_selected: self.save_selected,
            show_help: self.show_help,
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
        .constraints([
            Constraint::Length(28),
            Constraint::Min(0),
            Constraint::Length(48),
        ])
        .split(chunks[1]);
    render_ambient(f, body[0], u);
    render_map(f, body[1], u);
    // Right column: species roster (top), selected species description
    // (middle), history sparklines (bottom).
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(0),
            Constraint::Length(8),
            Constraint::Length(11),
        ])
        .split(body[2]);
    render_species(f, right[0], u);
    render_description(f, right[1], u);
    if u.perf_view {
        render_perf(f, right[2], u);
    } else {
        render_history(f, right[2], u);
    }
    render_help(f, chunks[2], u);
    // Pop-up renders last so it covers everything underneath.
    if u.save_list.is_some() {
        render_save_popup(f, chunks[1], u);
    } else if u.show_help {
        render_help_popup(f, chunks[1]);
    }
}

fn render_help_popup(f: &mut ratatui::Frame<'_>, area: Rect) {
    let w = 56.min(area.width.saturating_sub(4));
    let h = 20.min(area.height.saturating_sub(4));
    let popup = Rect {
        x: area.x + area.width.saturating_sub(w) / 2,
        y: area.y + area.height.saturating_sub(h) / 2,
        width: w,
        height: h,
    };
    f.render_widget(ratatui::widgets::Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .title("keys -- ? closes");
    let inner = block.inner(popup);
    f.render_widget(block, popup);
    let lines: Vec<Line<'static>> = vec![
        Line::raw("q / Esc       quit"),
        Line::raw("space / p     pause / resume"),
        Line::raw(".             single-tick step (while paused)"),
        Line::raw("] [ + -       sim rate × / ÷ 2"),
        Line::raw("M             snap sim rate to max (32x)"),
        Line::raw("j k ↑ ↓       species roster cursor"),
        Line::raw("m             toggle perf / history view"),
        Line::raw("s             save snapshot"),
        Line::raw("L             list / load saves"),
        Line::raw("x             admin: reset world"),
        Line::raw("X             admin: kill selected species cell"),
        Line::raw("E             admin: export world JSON to cwd"),
        Line::raw("?             show this help"),
    ];
    f.render_widget(Paragraph::new(lines), inner);
}

fn render_history(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let block = Block::default().borders(Borders::ALL).title("history (~60s)");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.height < 3 || u.history_cells.is_empty() {
        return;
    }
    // Three stacked sparklines: cells, species, mass.
    let h = inner.height as usize;
    let row = (h / 3).max(1) as u16;
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(row),
            Constraint::Length(row),
            Constraint::Min(1),
        ])
        .split(inner);
    let cell_max = *u.history_cells.iter().max().unwrap_or(&1);
    let spc_max = *u.history_species.iter().max().unwrap_or(&1);
    let mass_max = *u.history_mass.iter().max().unwrap_or(&1);
    let cells = Sparkline::default()
        .block(Block::default().title(format!("cells ({})", cell_max)))
        .data(&u.history_cells)
        .style(Style::default().fg(Color::LightGreen))
        .max(cell_max.max(1));
    let species = Sparkline::default()
        .block(Block::default().title(format!("species ({})", spc_max)))
        .data(&u.history_species)
        .style(Style::default().fg(Color::LightCyan))
        .max(spc_max.max(1));
    let mass = Sparkline::default()
        .block(Block::default().title(format!("mass ({})", mass_max)))
        .data(&u.history_mass)
        .style(Style::default().fg(Color::LightYellow))
        .max(mass_max.max(1));
    f.render_widget(cells, layout[0]);
    f.render_widget(species, layout[1]);
    f.render_widget(mass, layout[2]);
}

/// Perf view: two sparklines (tick wall-time, particle count) over the
/// last ~60s plus the top-5 most expensive engine passes by EMA. Hit
/// `m` to toggle back to the cells/species/mass history.
fn render_perf(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title("perf (~60s) -- 'm' toggles");
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.height < 3 {
        return;
    }
    let Some(s) = &u.last_snapshot else {
        return;
    };

    // Layout: tick sparkline (top), particles sparkline (mid),
    // top-N passes text list (bottom).
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Length(2),
            Constraint::Min(0),
        ])
        .split(inner);

    let tick_max = *u.history_tick_us.iter().max().unwrap_or(&1);
    let part_max = *u.history_particles.iter().max().unwrap_or(&1);
    let tick_ms = s.perf.tick_ms;
    let tick_sp = Sparkline::default()
        .block(Block::default().title(format!(
            "tick ({:.2} ms, peak {:.2})",
            tick_ms,
            tick_max as f32 / 1000.0
        )))
        .data(&u.history_tick_us)
        .style(Style::default().fg(Color::LightYellow))
        .max(tick_max.max(1));
    let part_sp = Sparkline::default()
        .block(Block::default().title(format!(
            "particles ({}, peak {})",
            s.particles.count, part_max
        )))
        .data(&u.history_particles)
        .style(Style::default().fg(Color::LightCyan))
        .max(part_max.max(1));
    f.render_widget(tick_sp, layout[0]);
    f.render_widget(part_sp, layout[1]);

    // Top-N pass breakdown: label, ms, share of tick.
    let perf = &s.perf;
    let pairs: [(&str, f32); 21] = [
        ("forces", perf.forces_ms),
        ("collision", perf.collision_ms),
        ("particle_decay", perf.particle_decay_ms),
        ("vm", perf.vm_ms),
        ("creature_col", perf.creature_collision_ms),
        ("obstacle_col", perf.obstacle_collision_ms),
        ("cell_reactions", perf.cell_reactions_ms),
        ("transport", perf.transport_ms),
        ("ambient", perf.ambient_ms),
        ("diffuse", perf.diffuse_ms),
        ("precipitation", perf.precipitation_ms),
        ("region_temp", perf.region_temp_ms),
        ("vent", perf.vent_ms),
        ("predate", perf.predate_ms),
        ("ingest", perf.ingest_ms),
        ("reproduction", perf.reproduction_ms),
        ("death", perf.death_ms),
        ("maintenance", perf.maintenance_ms),
        ("bonding", perf.bonding_ms),
        ("activation", perf.activation_ms),
        ("snapshot", perf.snapshot_ms),
    ];
    let mut sorted: Vec<(&str, f32)> = pairs.into_iter().collect();
    sorted.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let rows = layout[2].height.saturating_sub(1) as usize;
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(rows + 1);
    lines.push(Line::from(vec![Span::styled(
        "pass              ms    %",
        Style::default().add_modifier(Modifier::BOLD),
    )]));
    let total = tick_ms.max(1e-3);
    for (label, ms) in sorted.iter().take(rows) {
        let share = (ms / total) * 100.0;
        let line = format!("{label:<14} {ms:>6.2} {share:>4.0}");
        lines.push(Line::from(vec![Span::styled(
            line,
            Style::default().fg(Color::White),
        )]));
    }
    let p = Paragraph::new(lines);
    f.render_widget(p, layout[2]);
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
        let reseeded = if s.auto_reseeds > 0 {
            format!(" reseeds={}", s.auto_reseeds)
        } else {
            String::new()
        };
        let temp = {
            let (mean, lo, hi) = s.temp_stats;
            if mean == 0.0 && lo == 0.0 && hi == 0.0 {
                String::new()
            } else {
                format!(" T={mean:.1}°C[{lo:.0}..{hi:.0}]")
            }
        };
        let lag = u
            .last_snapshot_at
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        format!(
            "t={t:.0}s tick={tick} {day} light={light:.2}{temp} | cells={cells} species={species} bonds={bonds} parts={parts} mass={mass:.0} | rate={rate:.2}x{running}{admin}{reseeded} | lag={lag}ms",
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

fn render_ambient(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let block = Block::default().borders(Borders::ALL).title("ambient");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let Some(s) = &u.last_snapshot else { return };
    if s.ambient_chems.is_empty() {
        return;
    }

    // Rank chems by current ambient mass; show top-N that fits.
    let mut indexed: Vec<(usize, f32)> = s
        .ambient_chems
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, m)| *m > 0.0)
        .collect();
    indexed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let max_mass = indexed.first().map(|(_, m)| *m).unwrap_or(1.0).max(1.0);
    let rows = inner.height.saturating_sub(1) as usize;
    let label_w = (inner.width.saturating_sub(2) as usize).min(10);
    let bar_w = (inner.width as usize).saturating_sub(label_w + 8);

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(rows + 1);
    lines.push(Line::from(vec![Span::styled(
        "chem      mass",
        Style::default().add_modifier(Modifier::BOLD),
    )]));
    for (i, mass) in indexed.iter().take(rows) {
        let name = u
            .chem_names
            .get(*i)
            .cloned()
            .unwrap_or_else(|| format!("c{i}"));
        let mut label: String = name.chars().take(label_w).collect();
        while label.chars().count() < label_w {
            label.push(' ');
        }
        let fill = if bar_w > 0 {
            ((*mass / max_mass) * bar_w as f32).round() as usize
        } else {
            0
        };
        let bar = "█".repeat(fill.min(bar_w));
        let line = format!("{label} {mass:>6.0} {bar}");
        let color = colour_for_glyph(*i as u8);
        lines.push(Line::from(vec![Span::styled(
            line,
            Style::default().fg(color),
        )]));
    }
    let p = Paragraph::new(lines);
    f.render_widget(p, inner);
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
    let sel = u.selected_species.min(s.top_species.len().saturating_sub(1));
    for (i, sp) in s
        .top_species
        .iter()
        .enumerate()
        .take(inner.height.saturating_sub(1) as usize)
    {
        lines.push(format_species_line(i, sp, i == sel));
    }
    let p = Paragraph::new(lines);
    f.render_widget(p, inner);
}

fn format_species_line(i: usize, sp: &SpeciesSummary, selected: bool) -> Line<'static> {
    let g = species_glyph(i as u8);
    let cursor = if selected { '>' } else { ' ' };
    let line = format!(
        "{cursor} {g}    {count:>4}  {mass:>7.0}  {atp:>6.0}",
        count = sp.count,
        mass = sp.biomass,
        atp = sp.atp,
    );
    let color = colour_for_glyph(i as u8);
    let mut style = Style::default().fg(color);
    if selected {
        style = style.add_modifier(Modifier::BOLD | Modifier::REVERSED);
    }
    Line::from(vec![Span::styled(line, style)])
}

fn render_description(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let title = match u.last_snapshot.as_ref().and_then(|s| {
        s.top_species
            .get(u.selected_species.min(s.top_species.len().saturating_sub(1)))
    }) {
        Some(sp) => format!(
            "species {} ({})",
            species_glyph(
                u.selected_species
                    .min(u.last_snapshot.as_ref().map(|s| s.top_species.len()).unwrap_or(1) - 1)
                    as u8
            ),
            &sp.coding_key.chars().take(8).collect::<String>(),
        ),
        None => "species (none)".into(),
    };
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(area);
    f.render_widget(block, area);

    let Some(s) = &u.last_snapshot else { return };
    if s.top_species.is_empty() {
        return;
    }
    let idx = u.selected_species.min(s.top_species.len() - 1);
    let sp = &s.top_species[idx];

    // Description is multi-line plain text. Clip to panel width / height.
    let mut lines: Vec<Line<'static>> = Vec::new();
    let w = inner.width as usize;
    for raw in sp.description.lines().take(inner.height as usize) {
        let truncated: String = raw.chars().take(w).collect();
        lines.push(Line::raw(truncated));
    }
    if lines.is_empty() {
        lines.push(Line::raw("(no description)"));
    }
    let p = Paragraph::new(lines);
    f.render_widget(p, inner);
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
    let text =
        "q quit  space pause  . step  ]/[ rate  M max  j/k species  m perf  s save  L load  E export  X kill  x reset";
    let p = Paragraph::new(text).block(block);
    f.render_widget(p, area);
}

/// Cheap JSON-array-of-strings parser; the admin "saves" reply is
/// guaranteed to be this shape (no nested objects, no escape soup
/// beyond backslash-quote) so we don't pull in `serde_json` just to
/// read it.
fn parse_json_string_array(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            i += 1;
            let mut buf = String::new();
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    buf.push(bytes[i + 1] as char);
                    i += 2;
                } else {
                    buf.push(bytes[i] as char);
                    i += 1;
                }
            }
            out.push(buf);
        }
        i += 1;
    }
    out
}

/// Find the (x, y) of the first cell whose speciesIdx matches the
/// roster cursor, used to target the KillCell admin command. Falls
/// back to `None` if the snapshot is missing fields or no cell of
/// that species is currently in the top-N roster.
fn cell_position_for_species(snap: Option<&Snapshot>, species: usize) -> Option<(f32, f32)> {
    let s = snap?;
    let target = species as u8;
    let xb = s.creatures.blobs.iter().find(|b| b.name == "x").map(|b| as_f32(&b.data))?;
    let yb = s.creatures.blobs.iter().find(|b| b.name == "y").map(|b| as_f32(&b.data))?;
    let sids = s.creatures.blobs.iter().find(|b| b.name == "speciesIdx").map(|b| b.data.clone())?;
    for i in 0..(s.creatures.count as usize) {
        if sids.get(i).copied().unwrap_or(0xFF) == target {
            return Some((*xb.get(i)?, *yb.get(i)?));
        }
    }
    None
}

fn render_save_popup(f: &mut ratatui::Frame<'_>, area: Rect, u: &UiView) {
    let Some(list) = u.save_list.as_ref() else { return };
    // Centre a fixed-size popup over the body area.
    let w = 48.min(area.width.saturating_sub(4));
    let h = (list.len().min(16) as u16 + 4).min(area.height.saturating_sub(4));
    let popup = Rect {
        x: area.x + area.width.saturating_sub(w) / 2,
        y: area.y + area.height.saturating_sub(h) / 2,
        width: w,
        height: h,
    };
    f.render_widget(ratatui::widgets::Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .title("load -- Enter loads, Esc cancels");
    let inner = block.inner(popup);
    f.render_widget(block, popup);
    if list.is_empty() {
        f.render_widget(Paragraph::new("(no saves on disk)"), inner);
        return;
    }
    let sel = u.save_selected.min(list.len() - 1);
    let rows = inner.height as usize;
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(rows);
    for (i, name) in list.iter().take(rows).enumerate() {
        let cursor = if i == sel { '>' } else { ' ' };
        let line = format!("{cursor} {name}");
        let mut style = Style::default();
        if i == sel {
            style = style.add_modifier(Modifier::BOLD | Modifier::REVERSED);
        }
        lines.push(Line::from(vec![Span::styled(line, style)]));
    }
    f.render_widget(Paragraph::new(lines), inner);
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
