# ARCHITECTURE.md — Rocket Sim

**Purpose**: single reference so adding new features never breaks existing ones.
Read this before any structural change. If something here is wrong or stale,
fix this file in the same commit as the code change.

**Rule**: anything marked "MUST" is a hard contract. Breaking it is a bug,
not a design choice. If a contract needs to change, update every site that
depends on it AND this file in one commit.

---

## 1. Domain map — where each concern lives

| Concern | File(s) | Storage | Notes |
|---|---|---|---|
| Fleet records (boosters, stages, fairings, noses) | `js/fleet.js` | `rocketSim.fleet.v1` | localStorage; migrated on load |
| Families (grouping) | `js/fleet.js` | `rocketSim.families.v1` | one bottom member + stages/fairings |
| Stacks | `js/fleet.js` | `rocketSim.stacks.v1` | member ids bottom→top |
| Payloads | `js/fleet.js` | `rocketSim.payloads.v1` | satellites/cargo |
| Stack **type** | `stack.sequence` field | — | `'standard'`/`'legacy'`/`'heavy'`/`'sso'`/`'custom'` |
| Guidance blocks | `js/simJs/guidance/guidance-blocks.js` | — | pure logic, no localStorage |
| Guidance orchestrator | `js/simJs/guidance/guidance.js` | — | phase machine, config API |
| Guidance defaults | `js/guideConfigDefaults.js` | — | code-resident, never user-writable |
| Guidance presets (user) | `js/guidancePresets.js` | `rocketSim.guidancePresets.v1` | user-authored |
| Guidance ↔ stack type compat | `js/guideConfigDefaults.js` | — | `GUIDE_COMPATIBLE_STACK_TYPES` |
| Component types | `js/componentLibrary.js` | `rocketSim.componentLibrary.v1` | hardware registry |
| Physics loop | `js/simJs/core/physics.js`, `workerBridge.js` | — | worker thread |
| Tuner (search/optimize) | `atlas-prism/` | — | self-contained |

---

## 2. Contracts — shapes that MUST NOT change silently

### 2.1 Fleet record
```js
{
  id, name, locked, stageRole, familyId,
  height, width, dragCd, bodyShellFactor,
  engineTypeId, recoveryTypeId, rcsTypeId, hasRecovery,
  engineThrusters: { gimbal, fixed },
  rcsThruster: { thrusterTypeId, massFlowRate },
  bodyMetalTypeId, legsMetalTypeId,
  fuel: { typeId, tankHeight, tankWidth, baffleCount, baffleInnerRadiusFrac },
  params: { octaRadius, rcsTopY, rcsBottomY, ... },
  bodyDesign: { mode: 'solid'|'dsl', solidColor, dslText },
}
```
Role-specific extras (`booster`/`stage`/`interstage`/`payloadSpace`/`nose`) —
see `migrateRocketRecord()` in fleet.js for the full canonical shape.

**MUST**: never store derived values on a record (mass, height totals).
Compute on read via `stageDerivedMasses()` / `boosterDerivedMasses()` etc.

### 2.2 Stack record
```js
{
  id, name,
  members: [bottomId, ..., topId],   // bottom→top
  sequence: 'standard'|'legacy'|'heavy'|'sso'|'custom',
  payloadId,
  locked,
  derived: { interstage: { [boosterId]: { height, mass } } },
}
```

**MUST**: `sequence` is the stack TYPE. No separate `type` field. No rocket
prefix in values — a Starship uses `'standard'` or `'custom'`, never
`'sh-standard'`. See §6 anti-patterns.

### 2.3 Guidance config
Nested object keyed by section. Schema frozen at code time via
`GUIDE_DEFAULT_PRESETS[guideName].constants`. The live config from
`Guidance.getGuideConfig(guideName)` must match this schema exactly
(same keys, same leaf types). `validateConstantsStrict` enforces this.

**MUST**: `applyGuideConfig` always receives the FULL config, not a patch.
Sections persist across runs (`_v3Config`), so partial sends leave stale
values.

### 2.4 Guidance preset
```js
{
  id, name, description,
  guideName,
  stackId, stackName, stackType,   // ← binding (see §4.4)
  tags: [],
  constants: { ...nested... },
  mecoTimeS, payloadDeployTimeS,    // optional display
  isDefault: false,
  createdAt, updatedAt,
}
```

**MUST**: `stackType` captured at save time and immutable except via
`updateUserPreset({ stackType })`. If missing (legacy preset), treated as
"applies to any stack" for backward compat.

### 2.5 Tuner lattice point
```js
{ Gi, Tn, bi, li, meco }   // ALL integers, no floats
```
- `Gi`  = G / 0.01
- `Tn`  = T / 0.000125
- `bi`  = bias / 0.0001
- `li`  = lead / 0.0125 (ticks)
- `meco`= kg

**MUST**: every search operates on integer lattice. Convert to floats only
at the boundary (`toValues()`).

### 2.6 Tuner metrics (runEval return)
Flat scalar fields only. **MUST NOT** contain objects or arrays — the
determinism check compares via `Object.is` and will silently fail on
non-primitives. See `atlas-prism/lib/hook.js` for the full list.

### 2.7 Tuner engine result
```js
{
  ok, status,
  bestPoint, bestScore, bestMetrics, bestResidualKg, bestDeployS,
  bestSource,
  evals, breakdown, wallMs,
  log: [],
  leaderboard: [],
  meco,
}
```
Any engine (`registerStrategy`) MUST return this shape or `ui/host.js`
will render blanks (defensive — won't crash, but silently useless).

---

## 3. Data flow

### 3.1 Sim boot order (MUST match)
```
physicsStep(dt) → buildSnapshot() → Guidance.onSnapshot(snap)
```
Also: `buildSnapshot()` must set `b.ax/b.ay` and `b.pods` every tick.

### 3.2 Run init order (MUST match)
```
applyGuideConfig → resetState(0) → applyEnvironment → applyFueling
→ stopGuide → startGuide
```

### 3.3 Preset resolution when starting a guide
```
user clicks Start
  → read active stack's sequence ("standard")
  → check isGuideCompatibleWithStackType(guideName, "standard")
  → check getPresetsForGuideAndStack(guideName, "standard").length > 0
  → if both pass, start guide
  → else, alert with the failing gate's reason
```
Source of truth: `bindGuidanceToolbar()` in `controls.js`.

---

## 4. Extension recipes

### 4.1 Add a new rocket family (e.g. Starship)
1. Add hardware types (Raptor, Starship hull, etc.) to `js/componentLibrary.js`
2. Write seed functions in `js/fleet.js`: `seedStarshipBooster()`, etc.
3. Add `{ seed: seedStarshipBooster }` entries to `DEFAULT_RECORDS`
4. Add family entry to `DEFAULT_FAMILIES`
5. Add stack entry to `DEFAULT_STACKS` with `sequence: 'standard'` (or new type)
6. **Nothing else needs to change** — record roles drive the whole pipeline

### 4.2 Add a new stack type
Only if the SHAPE is new (not just a different rocket using an existing shape).
1. Pick a name: lowercase, no rocket prefix. `'trio'`, not `'f9-trio'`.
2. Add to `VALID_SEQ` in `js/fleet.js` — **two places**: `addStack` and `updateStack`
3. Add slot role array to `presetSlotRoles()` in `js/rockets-ui.js`
4. Add slot role array to `PRESET_ROLES` in **both**:
   - `js/fleet.js` `validateStack()`
   - `js/rockets-ui.js` `validateStack()`
5. Add hint text to `renderStackSequenceHint()`
6. Declare which guides can run on it: add entry to
   `GUIDE_COMPATIBLE_STACK_TYPES` in `js/guideConfigDefaults.js`

**Fragility warning**: `VALID_SEQ` and `PRESET_ROLES` are duplicated in two
files. If you forget one, the editor saves a stack the validator rejects.
Test by creating a stack of the new type in the UI after adding it.

### 4.3 Add a new guidance
1. Implement the guide in `guidance-blocks.js` (new block) or compose
   existing blocks in `guidance.js`
2. Register in `GUIDES` + add to `GUIDE_PHASE_SEQUENCES` + `GUIDE_PHASE_DISPLAY`
3. Add config bag + register `get`/`set` in `_GUIDE_CONFIGS`
4. Add default preset in `GUIDE_DEFAULT_PRESETS` (`js/guideConfigDefaults.js`)
5. Add important fields in `GUIDE_IMPORTANT_FIELDS`
6. Declare compatible stack types in `GUIDE_COMPATIBLE_STACK_TYPES`
7. Add guide name to `CURRENT_GUIDES` in `js/guidancePresetsPage.js`
8. If the guide has tunable constants, add descriptions to
   `js/guideConstantDescriptions.js`

### 4.4 Add a new guidance preset
**No code changes.** UI flow only:
- Open the Guidance System modal in the sim
- Select guide, adjust fields, "Save as preset"
- `stackType` is captured from the currently active stack automatically
- Preset appears in the presets page and the modal's preset dropdown,
  filtered by active stack type at read time

### 4.5 Add a new tuner engine (in `atlas-prism/`)
1. Copy `atlas-prism/engines/_template.js`
2. Change the `registerStrategy(name, ...)` first arg to a unique name
3. Implement `runTuner(point, opts)` returning the shape in §2.7
4. Add `<script src="engines/your-engine.js"></script>` to
   `atlas-prism/index.html` **after** `lib/registry.js` and **before**
   `ui/host.js`
5. No other file needs changes — the dropdown auto-populates via
   `listStrategies()`

### 4.6 Add a new hardware component type
1. Add the type to `js/componentLibrary.js` (kind, frame.slots,
   parameterSchema)
2. **Nothing else** — the fleet editor, mass derivation, and rendering
   all read types generically via `getComponentType()`

---

## 5. Fail-fast enforcement

### 5.1 Load-time reconciliation (already in place)
- `reconcileDefaultRecords` — syncs seeds with live records by id
- `reconcileDefaultFamilies`, `reconcileDefaultStacks`, `reconcileDefaultPayloads`
- `loadStacks()` runs the `f9-*` → generic sequence migration (idempotent)
- `runPayloadSpaceSplitOnce` — one-time legacy split migration

### 5.2 Runtime boot checks (`js/boot-checks.js`)
Runs once at sim boot. Logs architecture violations to console. See that
file for the check list. Non-fatal, but any `console.error` from there is a
real bug — treat it as fail-worthy before committing.

### 5.3 Migration policy
- Every breaking localStorage schema change gets a versioned marker key
  (`rocketSim.<feature>Done.v1`), same pattern as `PAYLOAD_SPLIT_DONE_KEY`
- Migration MUST be idempotent (running twice = same result)
- Migration runs in the loader (`loadFleet`, `loadStacks`, ...), not in a
  standalone script
- Never delete user data silently — migrate OR leave in place with warning

---

## 6. Anti-patterns — DO NOT

- ❌ **Hardcode rocket prefixes in stack types.** `'f9-standard'` is wrong;
  use `'standard'`. A Starship uses `'standard'` too. (Fixed in chat 29.)
- ❌ **Add object/array fields to `runEval` metrics.** Breaks tuner
  determinism (`Object.is` comparison). Flat scalars only.
- ❌ **Store derived values on fleet records.** Recompute always.
  Caches (`_sdmCache`, `_bdmCache`) live on the JS object, never persisted.
- ❌ **Read `state.activeBodyIndex` across ticks.** It changes when the
  active body switches (separation, take-control). Use record ids and
  `findStage()` / `findBooster()` / `findPayload()`.
- ❌ **Send partial config to `applyGuideConfig`.** Sections persist across
  runs. Always send the full nested object.
- ❌ **Switch on `stack.sequence` for behavior.** Use
  `isGuideCompatibleWithStackType()` for compatibility, and
  `presetSlotRoles()` for slot roles. Sequence values are data, not logic.
- ❌ **Edit `runner.js` or `js/simJs/threads/*` from tuner code.** Tuner is
  an additive layer; it reads/writes via public APIs only.
- ❌ **Assume the stage is `state.bodies[1]`.** Indexes shift after split
  and discard. Use `findStage(bodies)`.
- ❌ **Duplicate lookup tables across files without a sync marker.** e.g.
  `PRESET_ROLES` in fleet.js AND rockets-ui.js. Any edit MUST land in both
  — grep the whole repo for the table name before saving.
- ❌ **Add a new `GUIDE_DEFAULT_PRESETS` entry without `stackType`.** The
  `_mkDefault` factory defaults it to `'standard'`, but if you hand-write
  the entry, set it explicitly.

---

## 7. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Stack type value | lowercase, no rocket prefix | `'standard'`, `'heavy'`, `'sso'` |
| Guidance name | camelCase, version suffix | `'leoInsertionV3'` |
| Default preset id | `'default:<guideName>'` | `'default:leoInsertionV3'` |
| Storage key | `rocketSim.<domain>.v1` | `'rocketSim.guidancePresets.v1'` |
| Migration marker | `rocketSim.<feature>Done.v1` | `'rocketSim.payloadSplitDone.v1'` |
| Fleet record id | `rk_<base36><rand>` | `'rk_lx3k2a9f'` |
| Stack id | `stk_<base36><rand>` | `'stk_lx3k2a9f'` |
| Family id | `fam_<base36><rand>` | `'fam_lx3k2a9f'` |
| Tuner engine file | `engines/pro-<greek>.js` | `'pro-alpha.js'` |
| Tuner register key | `'proAlpha'` | matches filename, no dash |

---

## 8. Testing gates before commit

### 8.1 Tuner changes
```bash
cd atlas-prism/tests && node mock.js    # must print "ALL PASS"
```
Browser: open `atlas-prism/index.html`, run baseline, verify leaderboard.

### 8.2 Fleet / stack changes
- Open `rockets-earth.html`, create a new family, add members
- Verify `validateStack` reports VALID
- Save, reload, verify migration didn't corrupt the store

### 8.3 Guidance / preset changes
- Open `guidance_presets.html`, save a new preset
- Verify it appears with `stackName` and `stackType` on the card
- Open `simulation.html`, verify Start gates correctly

### 8.4 Physics / sim changes
- Baseline 320 km run: deploy ~590.46 s, apogee ~320.11 km, perigee ~319.99 km
- Determinism: run twice, metrics bit-identical

---

## 9. Tuner specifics

See `atlas-prism/README.md` for the tuner's internal architecture
(engine registry, primitives, metrics contract, extension recipe).

---

## 10. Source of truth hierarchy

When this doc and code disagree:
1. **Code wins** — but this doc must be updated in the same commit
2. `state.md` in atlas-prism is authoritative for tuner latest state
3. `multi-step-project.md` is the tuner's project plan (historical)

When you can't find an answer here, check code comments in the file that
owns the domain (see §1). If the answer was ambiguous, add it here.