const { Vec3 } = require('vec3')
const assert = require('assert')
const math = require('../math')
const conv = require('../conversions')
const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')

const { Physics, PlayerState } = require('prismarine-physics')

module.exports = inject

const PI = Math.PI
const PI_2 = Math.PI * 2
const PHYSICS_INTERVAL_MS = 50
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000 // 0.05
// The physics timestep stays 50ms (20Hz), but the real-time accumulator is polled far more often.
// On Windows, setInterval is clamped to the ~15.6ms system timer resolution, so a fixed-timestep
// accumulator that keeps its sub-tick remainder can carry enough phase that consecutive ticks (and
// their movement packets) fire well under 50ms apart — which strict server timer checks read as the
// client running ahead of real time. A self-rescheduling setTimeout(1) chain polls at ~1-2ms without
// the 100%-CPU busy-spin of setImmediate, so each tick lands within ~2ms of its 50ms grid point and
// consecutive movement packets stay evenly spaced. Physics math is unchanged (timestep is still
// 50ms); only the poll cadence is finer. The catch-up cap and backlog drop below handle stalls.
const PHYSICS_CHECK_INTERVAL_MS = 1

function inject (bot, { physicsEnabled, maxCatchupTicks }) {
  // Cap catch-up at one physics tick per poll, and drop (do not replay) any whole-tick backlog
  // beyond that (see doPhysics, after the loop). Each tick emits one movement packet; replaying a
  // stall's backlog would flush several packets in the same instant, which server-side timer
  // accounting reads as the client crediting more time than really elapsed. Under-sending is the
  // safe direction (the balance just falls behind), and the bot was genuinely frozen during the
  // stall, so skipping those ticks is also physically correct.
  const PHYSICS_CATCHUP_TICKS = maxCatchupTicks ?? 1
  // Optional send-spacing gate: never run a physics tick (the movement packet is emitted inside
  // it) less than MIN_TICK_GAP_MS after the previous tick. When a tick is due but too soon, defer
  // it (break, keep the accumulator) — the next poll re-checks and ticks as soon as the gap is
  // met. Because one tick == one movement packet == one tick of simulated displacement, deferring
  // only spaces the packets; it never fast-forwards position. Off by default: the fine-grained
  // poll alone keeps the send cadence clean; this is an extra safety lever, tunable via env.
  const MIN_TICK_GAP_MS = Number(process.env.MIN_TICK_GAP_MS) || 0
  // Accumulator cap, used when the gate is on (a whole-tick `%=` drop would discard the exact
  // tick a gate-defer intends to run next poll). Bound the accumulated backlog so a genuine long
  // stall can't later replay as a burst, while a normal gate-defer (accumulator just over one
  // timestep) is preserved and ticked on the next eligible poll. Excess real time beyond the cap
  // is dropped — a constant, invisible lag, never a progressive one.
  const MAX_ACCUM_S = 0.1 // 2 timesteps
  let lastTickTime = 0
  const world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }
  const physics = Physics(bot.registry, world)

  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')

  bot.jumpQueued = false
  bot.jumpTicks = 0 // autojump cooldown

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  let lastSentYaw = null
  let lastSentPitch = null
  // Within a single client tick, the vanilla client reads the rotation first, computes that
  // tick's movement under it, then reports the same rotation paired with the movement it produced
  // — the displacement and the reported yaw/pitch are always mutually consistent. bot.look() can
  // fire between/inside physics ticks and mutate bot.entity.yaw immediately; if that lands after
  // simulatePlayer committed this tick's move (computed under the old yaw) but before
  // updatePosition, the new yaw would be reported with the old-yaw displacement — a direction
  // mismatch to any server that re-predicts movement. So the rotation the engine actually moved
  // under is snapshotted at the tick boundary (right before simulatePlayer) and updatePosition
  // reports that snapshot; a look that lands mid-tick is deferred to the next tick's snapshot,
  // exactly like vanilla.
  let tickRotation = null
  // In vanilla, the teleport-accept PosRot the client sends on an incoming server teleport IS
  // that client tick's single movement packet — it replaces, not adds to, the per-tick send.
  // Track how many such resends are pending (a counter, not a boolean: more than one server
  // correction can land between two 20Hz physics ticks, since the network handler fires per
  // incoming packet) so the outgoing stream stays at one movement packet per tick even across a
  // correction storm. Non-racy: only ever decremented by a subsequent per-tick send, only ever
  // incremented by the (rare in vanilla) resend.
  let teleportResendsPending = 0
  // Vanilla sends the player-input packet whenever the key state differs from the last one sent.
  // Mirror that: cache the last bitfield we sent so we only re-send when WASD/jump/shift/sprint
  // actually changes. Starts null so the very first setControlState always sends.
  let lastSentInput = null
  // The vanilla client emits the START/STOP_SPRINTING entity_action from sendPosition, every
  // tick, immediately BEFORE the movement packet — the sprint command never lands after the
  // tick's move packet. Writing it synchronously at toggle time (an arbitrary point in the tick)
  // can land it after this tick's movement packet, out of the expected packet order for strict
  // servers. So setControlState defers it: this snapshot tracks the last sprint state actually
  // sent, and updatePosition emits the entity_action first whenever the state changed. Starts
  // false (a player spawns not sprinting).
  let wasSprinting = false
  let doPhysicsTimer = null
  let lastPhysicsFrameTime = null
  let shouldUsePhysics = false
  bot.physicsEnabled = physicsEnabled ?? true
  let deadTicks = 21

  const lastSent = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    time: 0,
    flags: { onGround: false, hasHorizontalCollision: false }
  }
  // The vanilla client gates the per-tick position send on a displacement threshold, not float
  // equality: move = lengthSquared(dx,dy,dz) > (2.0E-4)^2 || ++positionReminder >= 20, measured
  // against a persistent anchor that is reset ONLY when a move packet is actually sent — so
  // sub-threshold wobble accumulates against a fixed anchor — plus a forced re-send every 20
  // ticks (1s). Gating on exact float inequality instead fires a full absolute position packet on
  // any 1e-15 wobble, a large over-send that feeds server resync loops. The anchor is also
  // deliberately left untouched on an incoming teleport (vanilla does the same): the next real
  // move naturally resyncs it, and a correction that snaps a stable bot to the position it
  // already holds yields a sub-threshold delta, so the loop dies. Lazy-seeded from the current
  // position on first use (= the vanilla anchor at spawn).
  let moveAnchor = null // { x, y, z } persistent send-gate anchor
  let positionReminder = 0 // ++ each tick, forces a re-send at >= 20

  // ===========================================================================
  // HAPPY-GHAST FLYING-MOUNT DRIVER (26.2). A controllable happy ghast is a
  // CLIENT-AUTHORITATIVE flying vehicle: when the local player is its controlling passenger,
  // the client simulates the ghast's flight each tick and sends the vehicle-move packet with
  // the computed position, which the server applies verbatim.
  //
  // mineflayer previously sent NO move_vehicle for a ridden mob (only the Rot packet), so a
  // happy ghast the bot mounted never moved — the server does not derive ghast motion from the
  // player_input bitflags. It also broke the per-tick packet framing servers expect, since a
  // "flying" frame implies a vehicle move packet.
  //
  // This driver ports the vanilla ridden-input, tick-ridden, and flying-travel maths for the
  // ghast exactly. It runs only while the bot is the controlling passenger of a happy_ghast
  // that is NOT on still-timeout.
  const GHAST_DEG2RAD = Math.PI / 180.0
  const GH_FLYING_SPEED = 0.05 // FLYING_SPEED attribute default
  const GH_RIDDEN_INPUT_SCALE = Math.fround(3.9) * GH_FLYING_SPEED // vanilla 3.9F * flying speed
  const GH_TRAVEL_SPEED = Math.fround((Math.fround(GH_FLYING_SPEED) * 5.0) / 3.0) // vanilla *5/3
  const GH_AIR_DAMPING = 0.91 // flying-travel air damping
  const GH_WATER_DAMPING = 0.8 // flying-travel water damping
  const GH_LAVA_DAMPING = 0.5 // flying-travel lava damping
  const GH_WIDTH = 4.0 // happy_ghast bbox width (minecraft-data 1.21.x entities: width 4)
  const GH_HEIGHT = 4.0 // happy_ghast bbox height (minecraft-data 1.21.x entities: height 4)
  const GH_YAW_TURN = Math.fround(0.08) // mount yaw eases 8%/tick toward the rider yaw
  const GH_INPUT_EPS = 1e-7 // input-vector cutoff
  // local mount-simulation state, seeded on mount and advanced each tick.
  let ghastSim = null // { vel: Vec3, yawDeg, pitchDeg } | null
  function ghastWrapDegrees (a) { a %= 360; if (a >= 180) a -= 360; if (a < -180) a += 360; return a }
  // Ridden input: returns the pre-scaled flight impulse direction from the rider keys + pitch.
  function ghastRiddenInput (xxa, zza, pitchDeg, jumping) {
    let forward = 0.0
    let up = 0.0
    if (zza !== 0.0) {
      const pr = Math.fround(pitchDeg * GHAST_DEG2RAD)
      let forwardLook = Math.fround(Math.cos(pr))
      let upLook = -Math.fround(Math.sin(pr))
      if (zza < 0.0) { forwardLook *= -0.5; upLook *= -0.5 } // backwards: reverse + half
      up = upLook
      forward = forwardLook
    }
    if (jumping) up += 0.5 // jump lift
    return new Vec3(xxa * GH_RIDDEN_INPUT_SCALE, up * GH_RIDDEN_INPUT_SCALE, forward * GH_RIDDEN_INPUT_SCALE)
  }
  // Yaw-rotate the input X/Z (degrees) and scale by speed; Y passes through.
  function ghastInputVector (input, speed, yawDeg) {
    const len2 = input.x * input.x + input.y * input.y + input.z * input.z
    if (len2 < GH_INPUT_EPS) return new Vec3(0, 0, 0)
    let mx = input.x; let my = input.y; let mz = input.z
    if (len2 > 1.0) { const n = Math.sqrt(len2); mx /= n; my /= n; mz /= n }
    mx *= speed; my *= speed; mz *= speed
    const sin = Math.fround(Math.sin(Math.fround(yawDeg * GHAST_DEG2RAD)))
    const cos = Math.fround(Math.cos(Math.fround(yawDeg * GHAST_DEG2RAD)))
    return new Vec3(mx * cos - mz * sin, my, mz * cos + mx * sin)
  }
  // True iff the current vehicle is a happy ghast the bot controls (first passenger, harness implied by
  // server-accepted ride) and is not frozen on still-timeout. We approximate still-timeout via a short
  // post-mount grace already waited out by the rider before driving.
  function botControlsGhast () {
    const v = bot.vehicle
    if (!v || v.name !== 'happy_ghast') return false
    const ps = v.passengers
    if (!ps || ps.length === 0) return false
    return ps[0].id === bot.entity.id // controlling passenger == first passenger
  }
  // === flying-travel world interaction (collision + damping-medium select) ==========
  // The ridden ghast is client-authoritative, so the local simulation must also collide with the
  // world and pick the damping medium each tick — a bare `pos += vel` with air-only damping and
  // no collision clips through terrain/water and diverges from server-side prediction near walls
  // and liquid. The ghast AABB is bottom-centered on the entity position, width 4 / height 4.
  function ghastAABB (pos) {
    const hw = GH_WIDTH / 2
    return { minX: pos.x - hw, minY: pos.y, minZ: pos.z - hw, maxX: pos.x + hw, maxY: pos.y + GH_HEIGHT, maxZ: pos.z + hw }
  }
  // AABB per-axis offset primitives (identical to prismarine-physics AABB.computeOffset*): b = a static block
  // collision box, e = the moving ghast box; returns the clamped displacement along one axis.
  function ghOffX (b, e, dx) {
    if (e.maxY > b.minY && e.minY < b.maxY && e.maxZ > b.minZ && e.minZ < b.maxZ) {
      if (dx > 0 && e.maxX <= b.minX) dx = Math.min(b.minX - e.maxX, dx)
      else if (dx < 0 && e.minX >= b.maxX) dx = Math.max(b.maxX - e.minX, dx)
    }
    return dx
  }
  function ghOffY (b, e, dy) {
    if (e.maxX > b.minX && e.minX < b.maxX && e.maxZ > b.minZ && e.minZ < b.maxZ) {
      if (dy > 0 && e.maxY <= b.minY) dy = Math.min(b.minY - e.maxY, dy)
      else if (dy < 0 && e.minY >= b.maxY) dy = Math.max(b.maxY - e.minY, dy)
    }
    return dy
  }
  function ghOffZ (b, e, dz) {
    if (e.maxX > b.minX && e.minX < b.maxX && e.maxY > b.minY && e.minY < b.maxY) {
      if (dz > 0 && e.maxZ <= b.minZ) dz = Math.min(b.minZ - e.maxZ, dz)
      else if (dz < 0 && e.minZ >= b.maxZ) dz = Math.max(b.maxZ - e.minZ, dz)
    }
    return dz
  }
  // Gather static block collision boxes overlapping the swept query box (world block shapes). Null/unloaded
  // blocks contribute nothing (free flight through unsent chunks — the same null-safe behavior as the player).
  function ghGatherBBs (q) {
    const out = []
    const cur = new Vec3(0, 0, 0)
    for (cur.y = Math.floor(q.minY) - 1; cur.y <= Math.floor(q.maxY); cur.y++) {
      for (cur.z = Math.floor(q.minZ); cur.z <= Math.floor(q.maxZ); cur.z++) {
        for (cur.x = Math.floor(q.minX); cur.x <= Math.floor(q.maxX); cur.x++) {
          let block
          try { block = bot.blockAt(cur, false) } catch (e) { block = null }
          if (block && block.shapes && block.position) {
            for (const s of block.shapes) {
              out.push({
                minX: s[0] + block.position.x, minY: s[1] + block.position.y, minZ: s[2] + block.position.z,
                maxX: s[3] + block.position.x, maxY: s[4] + block.position.y, maxZ: s[5] + block.position.z
              })
            }
          }
        }
      }
    }
    return out
  }
  // Collide the swept AABB with the world: Y first, then X/Z ordered by |x| < |z| (the vanilla
  // sweep order). Returns the collided per-axis displacement (no boxes -> free flight).
  function ghastCollide (pos, vel) {
    let dx = vel.x; let dy = vel.y; let dz = vel.z
    if (dx === 0 && dy === 0 && dz === 0) return { dx: 0, dy: 0, dz: 0 }
    const q = ghastAABB(pos)
    if (dx < 0) q.minX += dx; else q.maxX += dx
    if (dy < 0) q.minY += dy; else q.maxY += dy
    if (dz < 0) q.minZ += dz; else q.maxZ += dz
    const bbs = ghGatherBBs(q)
    if (bbs.length === 0) return { dx, dy, dz } // open air: no collision
    const e = ghastAABB(pos)
    for (const b of bbs) dy = ghOffY(b, e, dy)
    e.minY += dy; e.maxY += dy
    const zFirst = Math.abs(dx) < Math.abs(dz)
    if (zFirst) { for (const b of bbs) dz = ghOffZ(b, e, dz); e.minZ += dz; e.maxZ += dz }
    for (const b of bbs) dx = ghOffX(b, e, dx)
    e.minX += dx; e.maxX += dx
    if (!zFirst) { for (const b of bbs) dz = ghOffZ(b, e, dz); e.minZ += dz; e.maxZ += dz }
    return { dx, dy, dz }
  }
  // Flying-travel medium select: water (0.8) if any water intersects the ghast AABB, else lava
  // (0.5) if any lava does, else air (0.91). Vanilla checks the medium at travel entry (pre-move);
  // we scan the (0.001-deflated) box for water/lava/waterlogged cells, water taking precedence.
  function ghastMediumDamping (pos) {
    const hw = GH_WIDTH / 2
    const bb = { minX: pos.x - hw + 0.001, minY: pos.y + 0.001, minZ: pos.z - hw + 0.001,
      maxX: pos.x + hw - 0.001, maxY: pos.y + GH_HEIGHT - 0.001, maxZ: pos.z + hw - 0.001 }
    let water = false; let lava = false
    const cur = new Vec3(0, 0, 0)
    for (cur.y = Math.floor(bb.minY); cur.y <= Math.floor(bb.maxY); cur.y++) {
      for (cur.z = Math.floor(bb.minZ); cur.z <= Math.floor(bb.maxZ); cur.z++) {
        for (cur.x = Math.floor(bb.minX); cur.x <= Math.floor(bb.maxX); cur.x++) {
          let block
          try { block = bot.blockAt(cur, false) } catch (e) { block = null }
          if (!block) continue
          const n = block.name
          if (n === 'water' || n === 'bubble_column' || n === 'kelp' || n === 'kelp_plant' || n === 'seagrass' || n === 'tall_seagrass') water = true
          else if (n === 'lava') lava = true
          else if (block.getProperties) { try { if (block.getProperties().waterlogged === true) water = true } catch (e) { /* no props */ } }
        }
      }
    }
    if (water) return GH_WATER_DAMPING
    if (lava) return GH_LAVA_DAMPING
    return GH_AIR_DAMPING
  }
  // Advance the ghast flight one tick from the bot's controlState + look, mutate the vehicle entity
  // position, and send the authoritative move_vehicle packet (+ player_input intent).
  let _ghDiagN = 0
  function tickGhastFlight () {
    const v = bot.vehicle
    if (!ghastSim) {
      // Seed the CLIENT-AUTHORITATIVE mount state from the server's current vehicle position. From here the
      // client owns the position: we advance ghastSim.pos locally each tick and send it. We only resync to the
      // server value when the server EXPLICITLY teleports the vehicle (an incoming entity move/teleport changes
      // v.position out from under us — detected below), which is the server's setback/correction signal.
      ghastSim = {
        pos: v.position.clone(),
        vel: new Vec3(0, 0, 0),
        yawDeg: conv.toNotchianYaw(bot.entity.yaw),
        pitchDeg: conv.toNotchianPitch(bot.entity.pitch) * 0.5,
        lastWritten: v.position.clone()
      }
    }
    // SERVER RESYNC: if the server moved the vehicle since our last write (incoming teleport/correction), adopt
    // it as the new authoritative base and bleed velocity — otherwise our local pos would diverge and every
    // move_vehicle would be rejected ("moved wrongly") forever. A <1e-4 delta == our own echo, ignore it.
    if (v.position.distanceTo(ghastSim.lastWritten) > 1e-4) {
      ghastSim.pos = v.position.clone()
      ghastSim.vel = new Vec3(0, 0, 0)
    }
    // rider axes: zza = forward(+1)/back(-1); xxa = strafe left(+1)/right(-1) — vanilla Input sign (left=+).
    const zza = (controlState.forward ? 1 : 0) - (controlState.back ? 1 : 0)
    const xxa = (controlState.left ? 1 : 0) - (controlState.right ? 1 : 0)
    const jumping = !!controlState.jump
    const riderYaw = conv.toNotchianYaw(bot.entity.yaw)
    const riderPitch = conv.toNotchianPitch(bot.entity.pitch)
    // 1) getRiddenInput (impulse dir, pre-scaled)
    const ri = ghastRiddenInput(xxa, zza, riderPitch, jumping)
    // 2) tickRidden: ease mount yaw 8%/tick toward rider yaw; mount pitch = rider pitch * 0.5
    const diff = ghastWrapDegrees(riderYaw - ghastSim.yawDeg)
    ghastSim.yawDeg = ghastSim.yawDeg + diff * GH_YAW_TURN
    ghastSim.pitchDeg = Math.fround(riderPitch * 0.5)
    // 3) moveRelative: vel += yaw-rotated, speed-scaled impulse
    const impulse = ghastInputVector(ri, GH_TRAVEL_SPEED, ghastSim.yawDeg)
    ghastSim.vel = ghastSim.vel.plus(impulse)
    // damping factor is chosen by the medium the body occupies THIS tick, evaluated at travel
    // entry (pre-move position): water 0.8 / lava 0.5 / air 0.91.
    const damping = ghastMediumDamping(ghastSim.pos)
    // 4) move: sweep the ghast AABB through the world, then zero any collided-axis velocity
    //    (a blocked component drops to 0, as in vanilla). Unloaded chunks -> no boxes -> free.
    const collided = ghastCollide(ghastSim.pos, ghastSim.vel)
    if (collided.dx !== ghastSim.vel.x) ghastSim.vel.x = 0
    if (collided.dy !== ghastSim.vel.y) ghastSim.vel.y = 0
    if (collided.dz !== ghastSim.vel.z) ghastSim.vel.z = 0
    const newPos = new Vec3(ghastSim.pos.x + collided.dx, ghastSim.pos.y + collided.dy, ghastSim.pos.z + collided.dz)
    ghastSim.pos = newPos
    ghastSim.lastWritten = newPos.clone()
    v.position.set(newPos.x, newPos.y, newPos.z)
    // 5) damping on all 3 axes (no gravity in flying travel — water 0.8 / lava 0.5 / air 0.91).
    ghastSim.vel = ghastSim.vel.scaled(damping)
    // emit the rider input intent so the server sees the controlling input. The Rot + vehicle_move
    // sends happen in the caller in vanilla order (Rot first, then sendGhastVehicleMove()).
    try { sendPlayerInput() } catch (e) { /* keep flying */ }
    ghastSim._pendingPos = newPos
    void _ghDiagN
  }
  // Send the authoritative vehicle position computed by the most recent tickGhastFlight(). Called
  // AFTER the Rot packet so the per-tick send order is Rot -> move_vehicle (the vanilla order).
  function sendGhastVehicleMove () {
    if (!ghastSim || !ghastSim._pendingPos) return
    const p = ghastSim._pendingPos
    try {
      bot._client.write('vehicle_move', {
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: Math.fround(ghastSim.yawDeg),
        pitch: Math.fround(ghastSim.pitchDeg),
        onGround: false
      })
    } catch (e) { /* packet may not exist on this ver */ }
  }
  bot.on('dismount', () => { ghastSim = null })
  // ===========================================================================

  // This function should be executed each tick (every 0.05 seconds)
  // How it works: https://gafferongames.com/post/fix_your_timestep/

  // WARNING: THIS IS NOT ACCURATE ON WINDOWS (15.6 Timer Resolution)
  // use WSL or switch to Linux
  // see: https://discord.com/channels/413438066984747026/519952494768685086/901948718255833158
  let timeAccumulator = 0
  let catchupTicks = 0
  function doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
    lastPhysicsFrameTime = now

    timeAccumulator += deltaSeconds
    catchupTicks = 0
    while (timeAccumulator >= PHYSICS_TIMESTEP) {
      // Send-spacing gate: a tick emits one movement packet; never emit two less than
      // MIN_TICK_GAP_MS apart. If a tick is due but too soon since the last one, defer it (keep
      // the accumulator; the next poll re-checks).
      if ((now - lastTickTime) < MIN_TICK_GAP_MS) break
      tickPhysics(now)
      lastTickTime = now
      timeAccumulator -= PHYSICS_TIMESTEP
      catchupTicks++
      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
    }
    if (MIN_TICK_GAP_MS > 0) {
      // Gate on (optional): cap the backlog so a long stall can't replay as a packet burst,
      // WITHOUT discarding a normal gate-deferred tick (a `%=` drop would discard it and the bot
      // would crawl). Off by default.
      if (timeAccumulator > MAX_ACCUM_S) {
        timeAccumulator = MAX_ACCUM_S
      }
    } else {
      // Gate off (default): whole-tick backlog drop. After a long stall the accumulator still
      // holds >= 1 timestep; replaying it would flush a burst of movement packets faster than
      // real time. Drop the whole-tick backlog (keep only the sub-tick remainder) so the move
      // stream stays <= 1 packet per ~50ms of real time. No-op in steady 20Hz operation.
      if (timeAccumulator >= PHYSICS_TIMESTEP) {
        timeAccumulator %= PHYSICS_TIMESTEP
      }
    }
  }

  function tickPhysics (now) {
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return // entity not ready
    if (bot.blockAt(bot.entity.position) == null) return // check if chunk is unloaded
    // MERGE (#dev integration, additive): announce the tick start before any movement/packet work so the
    // entity-prediction plugin (entity_physics.js) and waitForTicks(_, tickBegin=true) can hook the tick
    // BEGIN boundary. This does NOT alter our validated send-layer ordering below.
    bot.emit('physicsTickBegin')
    // Snapshot the rotation the engine is about to MOVE UNDER, at the tick boundary BEFORE
    // simulatePlayer runs (vanilla reads the rotation at the top of the tick, before travel).
    // updatePosition (this same tick) will report THIS rotation, so the reported yaw/pitch always
    // matches the displacement this tick produced; a bot.look that lands mid-tick is deferred to
    // next tick's snapshot. Captured even when physics is paused so updatePosition is safe.
    tickRotation = { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
    // Note: the teleport-resend counter is deliberately NOT reset here. The incoming server
    // `position` packet arrives asynchronously (network), not inside the tick, so resetting at
    // the tick boundary would destroy the pending count before updatePosition could consume it.
    if (bot.physicsEnabled && shouldUsePhysics) {
      physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
      // MERGE (#dev integration, additive): drive entity-prediction physics (entity_physics.js listens on
      // 'entityPhysicsTick') right after the player's own simulate, before the player packet send. Disjoint
      // from our net layer — entity_physics simulates OTHER entities only, never touches bot.entity packets.
      bot.emit('entityPhysicsTick')
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (bot.entity.elytraFlying && bot.entity.onGround) {
      // FORCE-clear: we have locally landed, so end the speculative glide latch even though the server's self
      // metadata never reported 0x80 (the un-forced swallow guard would otherwise keep us "flying" on ground).
      bot._setElytraFlyingState?.(bot.entity, false, true)
    }
    if (bot.fireworkRocketDuration > 0) {
      bot.fireworkRocketDuration--
    }
    if (shouldUsePhysics) {
      updatePosition(now)
      // 1.21.2+ clients send the client tick_end packet once per client tick, AFTER the player
      // tick (and thus after the single movement packet). Server-side per-tick packet framing
      // depends on it, so send it once per physics tick, right after the movement packet.
      if (bot.supportFeature('newPlayerInputPacket')) {
        try { bot._client.write('tick_end', {}) } catch (e) { /* packet may not exist on this ver */ }
      }
    } else if (bot.vehicle) {
      // While mounted, mineflayer gates all per-tick sends behind shouldUsePhysics (false on
      // mount), which would leave the client silent — no rotation packet and no tick_end each
      // tick — breaking the per-tick packet framing modern servers expect for a ridden player.
      // The vanilla client, while a passenger, still sends EVERY tick a Rot packet carrying the
      // real onGround/horizontalCollision (and, only when the root vehicle is locally
      // authoritative, a vehicle-move packet — a server-driven vehicle is not, so that one is
      // correctly omitted here), then the once-per-tick tick_end. Mirror that exactly.
      try {
        // tickRotation/bot.entity.yaw are INTERNAL radians; sendPacketLook expects Notchian WIRE degrees, so
        // convert exactly as updatePosition does (conv.toNotchianYaw/Pitch).
        const iy = (tickRotation && tickRotation.yaw != null) ? tickRotation.yaw : bot.entity.yaw
        const ip = (tickRotation && tickRotation.pitch != null) ? tickRotation.pitch : bot.entity.pitch
        const yaw = Math.fround(conv.toNotchianYaw(iy))
        const pitch = Math.fround(conv.toNotchianPitch(ip))
        // Passenger onGround: while mounted, mineflayer leaves bot.entity.onGround frozen at its
        // pre-mount value (usually TRUE — the bot stood on the floor before mounting, and nothing
        // re-derives it while player physics is off). But a passenger is positioned AT THE
        // VEHICLE SEAT, which sits above the ground, so the rider's AABB does not touch terrain
        // and a real client reports onGround FALSE while riding a mob mount. Sending the stale
        // TRUE reads as a no-fall violation to strict servers; false is vanilla-faithful for an
        // elevated seat and can never trip a no-fall check (which only fires on a claimed
        // onGround=true), so boat/minecart rides are unaffected.
        // Happy ghast: the per-tick Rot packet carries the RIDER's own look, NOT the mount
        // rotation — the eased mount rotation belongs only in the move_vehicle packet (sent by
        // sendGhastVehicleMove below). tickGhastFlight() still runs first as a pre-pass so
        // ghastSim / _pendingPos are current for the move_vehicle send.
        if (botControlsGhast()) {
          try { tickGhastFlight() } catch (e) { /* keep ticking */ }
          sendPacketLook(yaw, pitch, false) // Rot = rider look
          sendGhastVehicleMove() // then move_vehicle carries the mount rotation (vanilla order)
        } else {
          sendPacketLook(yaw, pitch, false)
        }
      } catch (e) { /* keep ticking even if a send fails */ }
      if (bot.supportFeature('newPlayerInputPacket')) {
        try { bot._client.write('tick_end', {}) } catch (e) { /* packet may not exist on this ver */ }
      }
    }
  }

  // remove this when 'physicTick' is removed
  bot.on('newListener', (name) => {
    if (name === 'physicTick') console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use this event (physicsTick) instead.')
  })

  function cleanup () {
    clearTimeout(doPhysicsTimer) // the poll is a self-rescheduling setTimeout chain, not a setInterval
    doPhysicsTimer = null
  }

  function sendPacketPosition (position, onGround) {
    // MERGE (#dev Velocity support, additive): suppress gameplay movement during the config phase.
    if (bot.inConfigurationPhase) return
    // sends data, no logic
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.onGround = onGround
    // Report the REAL horizontal-collision state, not a hardcoded false. The vanilla client sends
    // horizontalCollision in every move packet (1.21.3+), and the physics engine commits the
    // exact value onto bot.entity.isCollidedHorizontally after each tick. Claiming "not against a
    // wall" while pressing into one defeats the wall-press tolerance of servers that re-predict
    // movement and causes perpetual correction oscillation.
    lastSent.flags = { onGround, hasHorizontalCollision: bot.entity.isCollidedHorizontally === true } // 1.21.3+
    bot._client.write('position', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketLook (yaw, pitch, onGround) {
    // MERGE (#dev Velocity support, additive): suppress gameplay movement during the config phase.
    if (bot.inConfigurationPhase) return
    // sends data, no logic
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    // The vanilla Rot packet also carries horizontalCollision (see sendPacketPosition); report
    // the real engine-committed value.
    lastSent.flags = { onGround, hasHorizontalCollision: bot.entity.isCollidedHorizontally === true } // 1.21.3+
    bot._client.write('look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketPositionAndLook (position, yaw, pitch, onGround) {
    // MERGE (#dev Velocity support, additive): suppress gameplay movement during the config phase.
    if (bot.inConfigurationPhase) return
    // sends data, no logic
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    // The vanilla PosRot packet also carries horizontalCollision (see sendPacketPosition); report
    // the real engine-committed value.
    lastSent.flags = { onGround, hasHorizontalCollision: bot.entity.isCollidedHorizontally === true } // 1.21.3+
    bot._client.write('position_look', lastSent)
    bot.emit('move', oldPos)
  }

  function deltaYaw (yaw1, yaw2) {
    let dYaw = (yaw1 - yaw2) % PI_2
    if (dYaw < -PI) dYaw += PI_2
    else if (dYaw > PI) dYaw -= PI_2

    return dYaw
  }

  // The sent wire yaw is a linear map with NO 360 wrap, and lastSentYaw/bot.entity.yaw can be
  // assigned from two incompatible representations: an incoming server teleport yields a
  // euclidean [0,2pi) angle, while a forced bot.look keeps the caller's raw target in (-pi,pi].
  // The same physical heading can therefore differ by 2pi and emit wire values exactly 360
  // degrees apart. A real client's rotation is a continuous float (mouse deltas accumulate), so
  // consecutive packets never jump by a non-physical multiple of 360 — and servers diff the raw
  // wire yaw without normalization. Mirror the continuity exactly: wrap each sent wire yaw/pitch
  // to within +-180 of the PREVIOUS sent wire value, so identical/near headings always map to a
  // continuous wire stream. A deliberate >180 turn still wraps to a <=180 step (correct).
  function wrapWireDegNear (value, near) {
    if (!Number.isFinite(near)) return value
    let d = (value - near) % 360
    if (d < -180) d += 360
    else if (d > 180) d -= 360
    return near + d
  }

  // returns false if bot should send position packets
  function isEntityRemoved () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    if (deadTicks >= 20) return true
    return false
  }

  // Called FIRST inside updatePosition so the START/STOP_SPRINTING entity_action is emitted
  // BEFORE this tick's move packet, in lockstep with movement, exactly like the vanilla client.
  // Only emits on an actual sprint-state change, so it does not spam.
  function sendIsSprintingIfNeeded () {
    // Gate on the EFFECTIVE (post-tick) sprint state, NOT the raw control key. Vanilla gates on
    // isSprinting() — the entity's sprint flag after the tick forced sprint off while wading (in
    // water but not underwater) — and the physics engine writes that effective state back to
    // bot.entity.sprinting. Gating on the raw key (always true while sprint is held) would claim
    // sprint speed while the engine produces the slower wading speed, a sustained divergence for
    // any server that re-predicts movement. player_input still carries the RAW sprint key,
    // exactly like vanilla — that is unchanged.
    const effSprint = !!(bot.entity && bot.entity.sprinting)
    if (effSprint === wasSprinting) return
    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper')
        ? (effSprint ? 'start_sprinting' : 'stop_sprinting')
        : (effSprint ? 3 : 4),
      jumpBoost: 0
    })
    wasSprinting = effSprint
  }

  function updatePosition (now) {
    // Only send updates for 20 ticks after death
    if (isEntityRemoved()) return
    // Don't send position with invalid coordinates (NaN after death)
    if (!Number.isFinite(bot.entity.position.x)) return
    // MERGE (#dev Velocity support, additive): don't run the send chain during the config phase.
    if (bot.inConfigurationPhase) return

    // Do NOT suppress this tick's send when a teleport-accept resend fired. Server-side timer
    // accounting only counts normal per-tick movement packets — a teleport-accept PosRot is
    // explicitly not counted — and the vanilla client, in the same tick a teleport arrives, sends
    // the teleport-accept PosRot AND still runs its once-per-tick sendPosition. Suppressing the
    // counted send therefore starves the timer balance during a correction storm and freezes the
    // bot. The resend already set lastSent to the teleport target, so the normal send chain below
    // naturally diffs against it: while turning it emits a Rot (the counted per-tick packet), and
    // on a pure standstill it emits nothing extra (status-only fires only on an onGround/collision
    // change) — matching vanilla without over-sending. teleportResendsPending is now vestigial for
    // suppression; keep draining it so it can't accumulate.
    if (teleportResendsPending > 0) teleportResendsPending--

    // Emit the deferred sprint entity_action HERE (before the move packet below), mirroring the
    // vanilla client, which sends it first from sendPosition.
    sendIsSprintingIfNeeded()

    // Report the rotation the engine MOVED UNDER this tick (snapshotted at the tick boundary
    // before simulatePlayer), NOT the live bot.entity.yaw — a mid-tick bot.look may have already
    // mutated the live value, which would pair the NEW yaw with the OLD-yaw displacement (a
    // direction mismatch to any server that re-predicts movement). Fall back to the live value if
    // no snapshot yet (e.g. respawn/login first send).
    const rotYaw = tickRotation ? tickRotation.yaw : bot.entity.yaw
    const rotPitch = tickRotation ? tickRotation.pitch : bot.entity.pitch

    // Increment the yaw in baby steps so that notchian clients (not the server) can keep up.
    const dYaw = deltaYaw(rotYaw, lastSentYaw)
    const dPitch = rotPitch - (lastSentPitch || 0)

    // Vanilla doesn't clamp yaw, so we don't want to do it either
    const maxDeltaYaw = PHYSICS_TIMESTEP * physics.yawSpeed
    const maxDeltaPitch = PHYSICS_TIMESTEP * physics.pitchSpeed
    lastSentYaw += math.clamp(-maxDeltaYaw, dYaw, maxDeltaYaw)
    lastSentPitch += math.clamp(-maxDeltaPitch, dPitch, maxDeltaPitch)

    // Keep the WIRE yaw/pitch CONTINUOUS with the previously sent wire value (wrap each to within
    // +-180 of lastSent.yaw/pitch), so the dual representation of lastSentYaw (euclidean from a
    // server teleport vs raw from a forced bot.look) can never emit a phantom +-360 wire snap.
    // Vanilla rotations are continuous floats — this reproduces that continuity.
    const yaw = Math.fround(wrapWireDegNear(conv.toNotchianYaw(lastSentYaw), lastSent.yaw))
    const pitch = Math.fround(wrapWireDegNear(conv.toNotchianPitch(lastSentPitch), lastSent.pitch))
    // Expose the exact WIRE rotation THIS tick's movement packet carries (the tick-boundary
    // snapshot the engine moved under, after yaw-speed clamp + wire-wrap). The use_item packet
    // (inventory.js activateItem) must carry the SAME yaw/pitch the move packet does, exactly as
    // vanilla does — strict servers cross-check the two. Sending the raw look TARGET instead
    // (which diverges from the clamped/wrapped wire value) makes the use_item rotation differ
    // from the tick's movement rotation. Store the wire degrees for activateItem.
    bot._lastSentRotation = { yaw, pitch }
    const position = bot.entity.position
    const onGround = bot.entity.onGround

    // Gate the per-tick position send on vanilla's displacement threshold, NOT an exact-float
    // `lastSent.x !== position.x` test (which fires a full absolute Pos on any 1e-15 wobble):
    //   move = lengthSquared(dx,dy,dz) > (2.0E-4)^2 || ++positionReminder >= 20
    // The anchor is lazily seeded from position and accumulates against a FIXED anchor on
    // sub-threshold ticks (reset only when move is true), so steady wobble emits no Pos.
    if (moveAnchor === null) { moveAnchor = { x: position.x, y: position.y, z: position.z } }
    const dx = position.x - moveAnchor.x
    const dy = position.y - moveAnchor.y
    const dz = position.z - moveAnchor.z
    positionReminder++
    // (2.0E-4)^2 = 4e-8; positionReminder >= 20 is vanilla's once-per-second forced re-send.
    const positionUpdated = (dx * dx + dy * dy + dz * dz) > 4e-8 || positionReminder >= 20
    const lookUpdated = lastSent.yaw !== yaw || lastSent.pitch !== pitch

    if (positionUpdated && lookUpdated) {
      sendPacketPositionAndLook(position, yaw, pitch, onGround)
      lastSent.time = now // only reset if positionUpdated is true
      // vanilla resets the anchor + positionReminder only when a move packet is actually sent
      moveAnchor.x = position.x; moveAnchor.y = position.y; moveAnchor.z = position.z; positionReminder = 0
    } else if (positionUpdated) {
      sendPacketPosition(position, onGround)
      lastSent.time = now // only reset if positionUpdated is true
      moveAnchor.x = position.x; moveAnchor.y = position.y; moveAnchor.z = position.z; positionReminder = 0
    } else if (lookUpdated) {
      sendPacketLook(yaw, pitch, onGround)
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround) {
      // For versions < 1.12, one player packet should be sent every tick
      // for the server to update health correctly
      // For versions >= 1.12, onGround !== lastSent.onGround should be used, but it doesn't ever trigger outside of login
      // The vanilla status-only packet also re-sends when horizontalCollision changes and
      // carries it (see sendPacketPosition). Report the real value.
      bot._client.write('flying', {
        onGround: bot.entity.onGround,
        flags: { onGround: bot.entity.onGround, hasHorizontalCollision: bot.entity.isCollidedHorizontally === true } // 1.21.3+
      })
    }

    lastSent.onGround = bot.entity.onGround // onGround is always set
  }

  bot.physics = physics
  // MERGE (#dev integration, additive): entity_physics.js calls physics.simulate(ctx, bot.physicsWorld).
  // Expose the same null-safe world adapter our player simulate uses so entity prediction shares it.
  bot.physicsWorld = world

  function getEffectLevel (mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName]
    if (!effectDescriptor) {
      return 0
    }
    const effectInfo = effects[effectDescriptor.id]
    if (!effectInfo) {
      return 0
    }
    return effectInfo.amplifier + 1
  }

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) {
      throw new Error('Already elytra flying')
    } else if (bot.entity.onGround) {
      throw new Error('Unable to fly from ground')
    } else if (bot.entity.isInWater) {
      throw new Error('Unable to elytra fly while in water')
    }

    const mcData = require('minecraft-data')(bot.version)
    if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
      throw new Error('Unable to elytra fly with levitation effect')
    }

    const torsoSlot = bot.getEquipmentDestSlot('torso')
    const item = bot.inventory.slots[torsoSlot]
    if (item == null || item.name !== 'elytra') {
      throw new Error('Elytra must be equip to start flying')
    }
    // Elytra engage ordering: strict servers read the player's LAST player_input at the instant
    // the START_FLYING_WITH_ELYTRA entity_action arrives — jump must be FALSE then (jumping while
    // starting the glide is a violation), and TRUE on the FOLLOWING input update. So: send the
    // entity_action START while jump is released, then arm a one-shot jump edge consumed by the
    // very next sendPlayerInput(), so the jump=true rides the natural next-tick packet (one
    // packet per tick is preserved — injecting extra player_input packets around the engage tick
    // desyncs per-tick packet accounting). The edge is packet-layer only; it never touches
    // controlState, so the engine does not re-jump and the glide is not dropped.
    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
      jumpBoost: 0
    })
    if (bot.supportFeature('newPlayerInputPacket')) {
      bot._elytraJumpEdgePending = true
    }
    // Latch fall-flying locally on SEND (speculative), matching vanilla — the client sets the
    // shared flag immediately, and server-side movement prediction engages elytra the moment the
    // START packet is received. Some servers echo the self-entity shared_flags metadata back
    // WITHOUT the fall-flying bit, i.e. they never confirm fall-flying to the controlling player
    // — so gating the engine on a server confirm never engages, and letting the echo clear the
    // state flaps elytra on/off every tick. Latch true AND mark the state as locally speculative
    // so the false self-metadata echo is swallowed (see the _pendingElytraFlightConfirmation
    // guard in entities.js) until WE stop gliding (onGround).
    bot.entity._pendingElytraFlightConfirmation = true
    bot._setElytraFlyingState?.(bot.entity, true, true)
  }

  // Send the on-foot `player_input` packet reflecting the FULL controlState bitfield, mirroring
  // the vanilla per-tick input send. On 1.21.3+ the packet is the authoritative movement-intent
  // oracle — without it, servers that re-predict movement assume a standing player. The input
  // record is the WHOLE key state {forward,backward,left,right,jump,shift,sprint}; the server
  // replaces its last-known input with each packet, so every send MUST carry all bits (the old
  // sneak-only `{shift}` write zeroed the rest). We de-dupe on the encoded bitfield exactly like
  // vanilla's key-state change guard so we only emit on an actual change.
  // NOTE: mineflayer's controlState key is `back`; the packet field is `backward`.
  function sendPlayerInput () {
    if (!bot.supportFeature('newPlayerInputPacket')) return // pre-1.21.3: no player_input on foot
    // One-shot jump EDGE for the elytra engage: bot.elytraFly() armed bot._elytraJumpEdgePending
    // right after sending START_FLYING_WITH_ELYTRA — the single next player_input must carry
    // jump=true (see bot.elytraFly). OR jump into THIS one send only (one packet per tick is
    // preserved), bypass the bitfield de-dupe so it is guaranteed to emit, and consume the flag.
    // controlState.jump itself is untouched (the engine must not re-jump), so subsequent sends
    // carry the real released jump.
    const oneShotJump = bot._elytraJumpEdgePending === true
    // Encode to a comparable bitfield for the change gate.
    const jumpBit = (controlState.jump || oneShotJump) ? 16 : 0
    const bits =
      (controlState.forward ? 1 : 0) |
      (controlState.back ? 2 : 0) |
      (controlState.left ? 4 : 0) |
      (controlState.right ? 8 : 0) |
      jumpBit |
      (controlState.sneak ? 32 : 0) |
      (controlState.sprint ? 64 : 0)
    if (!oneShotJump && bits === lastSentInput) return
    if (oneShotJump) bot._elytraJumpEdgePending = false
    // Track the de-dupe baseline as the REAL control bitfield (jump released), so the natural release after
    // this one-shot true re-emits next tick exactly once.
    lastSentInput =
      (controlState.forward ? 1 : 0) | (controlState.back ? 2 : 0) | (controlState.left ? 4 : 0) |
      (controlState.right ? 8 : 0) | (controlState.jump ? 16 : 0) | (controlState.sneak ? 32 : 0) |
      (controlState.sprint ? 64 : 0)
    bot._client.write('player_input', {
      inputs: {
        forward: controlState.forward,
        backward: controlState.back,
        left: controlState.left,
        right: controlState.right,
        jump: controlState.jump || oneShotJump,
        shift: controlState.sneak,
        sprint: controlState.sprint
      }
    })
  }

  // MERGE (#dev, additive): set a control bit WITHOUT emitting the associated packet (player_input /
  // entity_action). Used for prediction/spoofing where the send-layer must not observe the change.
  bot.spoofControlState = (control, state) => {
    controlState[control] = state
  }

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'jump' && state) {
      bot.jumpQueued = true
    } else if (control === 'sprint') {
      // Do NOT send the sprint entity_action here (synchronously, mid-tick). It is deferred to
      // updatePosition -> sendIsSprintingIfNeeded(), emitted in lockstep BEFORE the per-tick move
      // packet, exactly like the vanilla client. Sending it here would land it AFTER the move
      // packet at an arbitrary toggle time — out of the packet order strict servers expect.
    } else if (control === 'sneak' && !bot.supportFeature('newPlayerInputPacket')) {
      // Legacy entity_action approach for versions < 1.21.3 (no player_input packet).
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: state ? 0 : 1,
        jumpBoost: 0
      })
    }
    // On 1.21.3+, every on-foot control change (forward/back/left/right/jump/sprint/sneak)
    // re-sends the full player_input bitfield so the server sees the movement intent.
    // (sendPlayerInput de-dupes, so jump/sprint above — which already emit their own packets —
    // only add a player_input bit-flip.)
    sendPlayerInput()
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  bot.controlState = {}

  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get () {
        return controlState[control]
      },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  let lookingTask = createDoneTask()

  bot.on('move', () => {
    if (!lookingTask.done && Math.abs(deltaYaw(bot.entity.yaw, lastSentYaw)) < 0.001) {
      lookingTask.finish()
    }
  })

  bot._client.on('explosion', explosion => {
    // TODO: emit an explosion event with more info
    // Modern versions are server-authoritative: the server computes the explosion knockback
    // vector and ships it in the explode packet; the client just ADDS it to its velocity.
    // Vanilla has NO creative gate on the client — it applies whatever the server sends (the
    // server already omits knockback for spectators / creative-flying). An old
    // `gameMode !== 'creative'` gate wrongly dropped knockback sent to a creative-non-flying
    // bot. Keep only the mineflayer physics opt-out.
    if (bot.physicsEnabled) {
      if (explosion.playerKnockback) { // 1.21.3+
        // Fixes issue #3635
        bot.entity.velocity.x += explosion.playerKnockback.x
        bot.entity.velocity.y += explosion.playerKnockback.y
        bot.entity.velocity.z += explosion.playerKnockback.z
      }
      if ('playerMotionX' in explosion) {
        bot.entity.velocity.x += explosion.playerMotionX
        bot.entity.velocity.y += explosion.playerMotionY
        bot.entity.velocity.z += explosion.playerMotionZ
      }
    }
  })

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) {
      lookingTask.finish() // finish the previous one
    }
    lookingTask = createTask()

    // this is done to bypass certain anticheat checks that detect the player's sensitivity
    // by calculating the gcd of how much they move the mouse each tick
    const sensitivity = conv.fromNotchianPitch(0.15) // this is equal to 100% sensitivity in vanilla
    const yawChange = Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity
    const pitchChange = Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity

    if (yawChange === 0 && pitchChange === 0) {
      return
    }

    bot.entity.yaw += yawChange
    bot.entity.pitch += pitchChange

    if (force) {
      lastSentYaw = yaw
      lastSentPitch = pitch
      return
    }

    await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  // 1.21.3+
  bot._client.on('player_rotation', (packet) => {
    bot.entity.yaw = conv.fromNotchianYaw(packet.yaw)
    bot.entity.pitch = conv.fromNotchianPitch(packet.pitch)
  })

  // player position and look (clientbound)
  bot._client.on('position', (packet) => {
    // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
    // e.g. when crouching/crawling/swimming. Can someone confirm?
    bot.entity.height = 1.8

    const vel = bot.entity.velocity
    const pos = bot.entity.position
    let newYaw, newPitch

    // Note: 1.20.5+ uses a bitflags object, older versions use a bitmask number
    if (typeof packet.flags === 'object') {
      // Modern path with bitflags object.
      // Resolve the absolute target yaw/pitch FIRST — the 1.21.2+ velocity model
      // (ROTATE_DELTA) needs the yaw/pitch delta to rotate carried momentum.
      const curNotchYaw = conv.toNotchianYaw(bot.entity.yaw)
      const curNotchPitch = conv.toNotchianPitch(bot.entity.pitch)
      newYaw = (packet.flags.yaw ? curNotchYaw : 0) + packet.yaw
      newPitch = (packet.flags.pitch ? curNotchPitch : 0) + packet.pitch

      // Velocity (deltaMovement). 1.21.2+ teleports carry a deltaMovement Vec3
      // (packet.dx/dy/dz) with its OWN per-axis relative flags — decoupled from the
      // POSITION flags. Per axis: relative (delta flag set) => keep + add current vel;
      // absolute => = packet delta. ROTATE_DELTA (yawDelta flag) first rotates the current
      // velocity by the yaw/pitch change (nether-portal momentum carry).
      // Gate on the packet actually carrying deltaMovement: pre-1.21.2 servers omit
      // dx/dy/dz and use the OLD model (velocity keyed off the position relatives).
      // Finite check, not typeof: a synthetic server (e.g. the internal test's fake server)
      // that writes the packet without dx/dy/dz serializes them as NaN on 1.21.2+ schemas,
      // and NaN is typeof 'number' — treating it as authoritative poisons the velocity.
      // Real 1.21.2+ servers always send finite doubles, so live behavior is unchanged.
      if (Number.isFinite(packet.dx)) {
        let cvx = vel.x; let cvy = vel.y; let cvz = vel.z
        if (packet.flags.yawDelta) {
          // rotation deltas in notchian degrees -> radians
          const dPitch = (curNotchPitch - newPitch) * Math.PI / 180
          const dYaw = (curNotchYaw - newYaw) * Math.PI / 180
          // Vec3.xRot(dPitch): y' = y*cos + z*sin ; z' = z*cos - y*sin
          const cp = Math.cos(dPitch); const sp = Math.sin(dPitch)
          const ry = cvy * cp + cvz * sp
          const rz1 = cvz * cp - cvy * sp
          cvy = ry; cvz = rz1
          // Vec3.yRot(dYaw): x' = x*cos + z*sin ; z' = z*cos - x*sin
          const cy = Math.cos(dYaw); const sy = Math.sin(dYaw)
          const rx = cvx * cy + cvz * sy
          const rz2 = cvz * cy - cvx * sy
          cvx = rx; cvz = rz2
        }
        vel.set(
          packet.flags.dx ? cvx + packet.dx : packet.dx,
          packet.flags.dy ? cvy + packet.dy : packet.dy,
          packet.flags.dz ? cvz + packet.dz : packet.dz
        )
      } else {
        // Pre-1.21.2 modern (object flags, no deltaMovement): velocity keyed off the
        // POSITION relatives — relative axis keeps vel, absolute zeroes it.
        vel.set(
          packet.flags.x ? vel.x : 0,
          packet.flags.y ? vel.y : 0,
          packet.flags.z ? vel.z : 0
        )
      }
      // Position: if flag is set the value is relative (add to current), else absolute.
      pos.set(
        packet.flags.x ? (pos.x + packet.x) : packet.x,
        packet.flags.y ? (pos.y + packet.y) : packet.y,
        packet.flags.z ? (pos.z + packet.z) : packet.z
      )
    } else {
      // Legacy path with bitmask number
      // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0
      )
      // If flag is set, then the corresponding value is relative, else it is absolute
      pos.set(
        packet.flags & 1 ? (pos.x + packet.x) : packet.x,
        packet.flags & 2 ? (pos.y + packet.y) : packet.y,
        packet.flags & 4 ? (pos.z + packet.z) : packet.z
      )
      newYaw = (packet.flags & 8 ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags & 16 ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    }

    bot.entity.yaw = conv.fromNotchianYaw(newYaw)
    bot.entity.pitch = conv.fromNotchianPitch(newPitch)
    // Do NOT hard-force onGround=false after a server teleport. The immediate position_look
    // (below) would then report onGround=false right after every teleport, reading as a flying
    // player and perpetuating correction loops. Leave onGround as the entity's real value
    // (physics re-evaluates it next tick).

    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })
    }

    // After death/respawn, delay the forced position_look response.
    // Sending it immediately causes "Invalid move player packet" kicks
    // on older servers, but the server needs it to complete the respawn.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      const delayedPos = pos.clone()
      const delayedYaw = newYaw
      const delayedPitch = newPitch
      const delayedOnGround = bot.entity.onGround
      setTimeout(() => {
        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
        shouldUsePhysics = true
        bot.jumpTicks = 0
        lastSentYaw = bot.entity.yaw
        lastSentPitch = bot.entity.pitch
        bot.emit('forcedMove')
      }, 1500)
      return
    }

    // While riding, the bot is a PASSENGER — its position is owned by the vehicle seat, NOT by
    // player ground physics. An incoming server position packet (the server re-seating the rider,
    // or a vehicle-driven resync) must NOT re-arm player physics, or the next physics frame runs
    // the on-foot branch (gravity/fall) instead of the vehicle branch — silencing the vehicle
    // driver and making the rider read as a falling player. Vanilla never runs ground physics
    // while a passenger. So while mounted, keep shouldUsePhysics FALSE so the vehicle branch
    // (Rot + move_vehicle) stays in control. (On dismount the next position packet re-arms it.)
    shouldUsePhysics = !bot.vehicle
    bot.jumpTicks = 0
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch

    // The vanilla teleport-accept re-send: on an incoming server teleport the client sends the
    // teleport_confirm (written above) AND IMMEDIATELY a PosRot movement packet reporting the
    // EXACT teleport target pos+rot. Strict servers mark a correction accepted only when a
    // subsequent movement packet reports the teleport's exact coordinates; without this re-send
    // the physics tick advances the bot away from the target before the next updatePosition, the
    // teleport stays pending, and the next correction supersedes it — a self-sustaining
    // correction loop. Legit server teleports are RARE in vanilla, so this single re-send (which
    // fires ONLY here, inside the incoming-teleport handler — it is NOT a per-tick send) is
    // harmless in steady movement and is exactly what stops the loop. Report the EXACT resolved
    // target (pos + newYaw/newPitch); onGround = the entity's current value.
    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)
    // This teleport-accept PosRot IS this tick's single movement packet (vanilla sendPosition
    // runs once per tick). Count it so the per-tick send layer can account for it — increment
    // (not set true) so clustered resends each count once. Cap so a runaway resend burst can
    // never starve the per-tick position stream (a real cluster is <= 2-3 corrections between
    // two 20Hz ticks).
    teleportResendsPending = Math.min(teleportResendsPending + 1, 3)
    bot.emit('forcedMove')
  })

  // MERGE (#dev, additive): optional second arg `tickBegin` lets callers wait on the tick BEGIN boundary
  // ('physicsTickBegin') instead of the default tick END ('physicsTick'). Our timeout/reject guard (which
  // we are ahead of #dev on) is preserved.
  bot.waitForTicks = async function (ticks, tickBegin = false) {
    if (ticks <= 0) return
    const eventName = tickBegin ? 'physicsTickBegin' : 'physicsTick'
    await new Promise((resolve, reject) => {
      // Assuming 20 ticks per second, add extra time for lag
      const timeout = setTimeout(() => {
        bot.removeListener(eventName, tickListener)
        reject(new Error(`Timeout waiting for ${ticks} ticks after ${(ticks * 50 + 5000)}ms`))
      }, ticks * 50 + 5000) // 50ms per tick + 5s buffer

      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          clearTimeout(timeout)
          bot.removeListener(eventName, tickListener)
          resolve()
        }
      }

      bot.on(eventName, tickListener)
    })
  }

  let respawnTimer = 0
  bot.on('mount', () => { shouldUsePhysics = false })
  // VEHICLE-DISMOUNT FIX: on mount shouldUsePhysics is set false (the server drives the vehicle, the player
  // sends no packets). It was only ever re-enabled by a server position/teleport packet (the forcedMove
  // handler). A normal eject sends that packet, but a forced dismount (the vehicle entity removed/killed, or
  // an input the server doesn't ack with a teleport) leaves shouldUsePhysics stuck false -> the player engine
  // never resumes and the bot is FROZEN on foot after dismount. Re-enable player physics on dismount so the
  // bot walks again immediately. (Vanilla resumes player movement the tick after leaving a vehicle.)
  bot.on('dismount', () => { shouldUsePhysics = true })
  bot.on('death', () => {
    shouldUsePhysics = false
    respawnTimer = Date.now()
  })
  bot.on('respawn', () => { shouldUsePhysics = false })
  bot.on('login', () => {
    shouldUsePhysics = false
    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      // Drive the poll with a self-rescheduling setTimeout chain (NOT setInterval). On Windows
      // setInterval is clamped to the ~15.6ms system timer resolution; a short setTimeout
      // re-armed each poll fires at ~1-2ms, so the fixed-timestep accumulator never carries
      // enough phase to bunch two move packets <50ms apart. clearTimeout in cleanup() stops the
      // chain (doPhysicsTimer set null there).
      if (process.env.PHYSICS_POLL_MODE === 'interval') { // optional legacy interval scheduler
        doPhysicsTimer = setInterval(doPhysics, 10)
      } else {
        doPhysicsTimer = setTimeout(function pollPhysics () {
          try { doPhysics() } finally {
            if (doPhysicsTimer !== null) doPhysicsTimer = setTimeout(pollPhysics, PHYSICS_CHECK_INTERVAL_MS)
          }
        }, PHYSICS_CHECK_INTERVAL_MS)
      }
    }
  })
  bot.on('end', cleanup)
}
