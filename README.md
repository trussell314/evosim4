# evosim4

A from-scratch evolutionary simulation. Cells live in a 2.5D thin-slice
water column, run a tiny stack-bytecode genome each tick, eat particles
or each other, fission with mutation, and evolve. A phylogeny strip
shows lineages over time.

## Running

```sh
npm install
npm run dev        # launches Vite, open the printed URL
npm test           # runs the simulation test suite (vitest)
npm run build      # production build into dist/
```

## Design philosophy

The point of this sim is to be a *substrate*, not a script. It provides
only the basic environment (a water column with light, temperature,
gas exchange, currents, a procedural reaction network) and a small set
of primitive tools cells can invoke from their genome (sense a
chemical, sense and emit across the light / vibration / electric / pH /
magnetic channels, synthesize a product, thrust, ingest, predate,
engulf, bond, splice DNA, reproduce). Nothing above that is hand-coded.

In particular, **organelles, multicellularity, signaling,
specialization, and any metabolic/behavioral strategy are not
implemented features** &mdash; they are outcomes the framework should
*permit* but never prescribe or steer. When a mechanism is added, the
test is "does this open a door?" not "does this make X happen?".
Behaviors that emerge need not mirror biology; the only bar is that
they arise from selection over the genome, not from engine rules that
assume them. Where the engine currently *forces* a behavior that
should instead be evolvable, that is a known gap (see `COLONY_GAPS.md`
and the review notes), not a feature.

## End goal

Run this for long enough to observe at least one successful, roughly
stable population, then dig into the genomes of the cells in that
population looking for interesting adaptations &mdash; behaviors,
metabolic strategies, or sensor-use patterns that survived because
they worked.

The simulation is built to support that goal:

- Phylogeny strip across the bottom tracks every species (defined as
  a unique genome) for the last 120 seconds, with divergence /
  convergence connectors. Picking a long-lived lane and clicking the
  cell shows its genome disassembly in the HUD.
- The HUD biology readout summarizes what a cell does at a glance
  (trophic mode, active energy pathways, fission cadence).
- Cells are colored by edit distance from the lineage&rsquo;s root genome
  (white = exact match, hue saturates as descendants diverge), so a
  lineage that has explored a lot of mutation space stands out.

## Done since the first cut

- **Metabolism in the genome.** Cells now bias their own biochemistry:
  `SYNTH CAT <slot>` / `SYNTH INH <slot>` synthesize catalyst /
  inhibitor proteins that up- or down-regulate specific reaction slots
  (respiration, photosynthesis, the biosynthesis chain, transporters),
  so burn-now-vs-build trade-offs are evolvable rather than identical
  for every cell. See `GENOME_ARCHETYPES.md` and `CHEM_IO_REFERENCE.md`.
- **Temperature as a modeled attribute.** A diffused temperature field
  (vent heat + depth gradient) feeds a Q10=2 rate scaling, so warm
  cells run hot and cold pockets slow down; extreme vent heat also
  denatures membranes unless the cell holds the heat-shock chaperone.
- **A sensory substrate.** Detection *and* active emission for light
  (incl. reflection, bioluminescence, and rock occlusion), vibration,
  electric field, pH, and magnetism &mdash; all unified as one field
  per channel with both natural and cell-emitted sources.

## To-do (eventually)

- **Periodic environmental stress events.** Things like a step change
  in dissolved O2 / CO2 ambient, a slug of light decay (cloud cover),
  or a temperature swing &mdash; recurring on some slow cycle so
  populations have to adapt instead of being one-shot wiped out. Now
  that temperature is modeled, a temperature swing would couple cleanly
  into the existing chemistry.
