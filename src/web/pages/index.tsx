import { useState, useEffect, useRef, useCallback } from "react";

type Vec = { x: number; y: number };
type Item = { x: number; y: number; type: "boost" | "oil" | "star"; timer: number };
type Car = {
  x: number; y: number; angle: number; speed: number;
  driftAngle: number; laps: number; nextCheckpoint: number;
};

const COURSES = [
  { name: "Circuit Park", color: "#4ECDC4", trackWidth: 80, points: generateOval(400, 300, 160, 120, 24) },
  { name: "Mountain Pass", color: "#FF6B6B", trackWidth: 70, points: generateTrack(400, 300, 8, 150, 80) },
  { name: "Night City", color: "#A29BFE", trackWidth: 75, points: generateTrack(400, 300, 12, 140, 100) },
];

function generateOval(cx: number, cy: number, rx: number, ry: number, n: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

function generateTrack(cx: number, cy: number, n: number, baseR: number, vary: number): Vec[] {
  const pts: Vec[] = [];
  const seed = n * 137;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = baseR + Math.sin(seed + i * 2.7) * vary * 0.5 + Math.cos(seed + i * 1.3) * vary * 0.5;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function catmullRom(pts: Vec[], segments: number): Vec[] {
  const result: Vec[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let t = 0; t < segments; t++) {
      const f = t / segments;
      const f2 = f * f, f3 = f2 * f;
      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * f + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * f + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * f2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * f3),
      });
    }
  }
  return result;
}

function dist(a: Vec, b: Vec) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }

function playSound(type: "engine" | "boost" | "drift" | "star" | "lap") {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === "boost") {
      osc.frequency.value = 300;
      osc.type = "sawtooth";
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc.start(); osc.stop(ctx.currentTime + 0.2);
    } else if (type === "drift") {
      osc.frequency.value = 200;
      osc.type = "sawtooth";
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.start(); osc.stop(ctx.currentTime + 0.1);
    } else if (type === "star") {
      osc.frequency.value = 1000;
      osc.type = "triangle";
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } else if (type === "lap") {
      [523, 659, 784].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = f; o.type = "triangle";
        g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.08);
        g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.08 + 0.12);
        o.start(ctx.currentTime + i * 0.08);
        o.stop(ctx.currentTime + i * 0.08 + 0.12);
      });
    }
  } catch {}
}

const TOTAL_LAPS = 3;

export default function TopRacer() {
  const [screen, setScreen] = useState<"menu" | "playing" | "results">("menu");
  const [courseIdx, setCourseIdx] = useState(0);
  const [bestTimes, setBestTimes] = useState<(number | null)[]>([null, null, null]);
  const [raceTime, setRaceTime] = useState(0);
  const [stars, setStars] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const carRef = useRef<Car>({ x: 0, y: 0, angle: 0, speed: 0, driftAngle: 0, laps: 0, nextCheckpoint: 1 });
  const itemsRef = useRef<Item[]>([]);
  const animRef = useRef(0);
  const startTimeRef = useRef(0);
  const raceTimeRef = useRef(0);
  const starsRef = useRef(0);
  const boostTimer = useRef(0);
  const trailRef = useRef<Vec[]>([]);
  const smoothTrack = useRef<Vec[]>([]);
  const touchRef = useRef<{ steer: number; gas: boolean; brake: boolean }>({ steer: 0, gas: false, brake: false });

  useEffect(() => {
    try {
      const saved = localStorage.getItem("topracer_best");
      if (saved) setBestTimes(JSON.parse(saved));
    } catch {}
  }, []);

  const startRace = useCallback((idx: number) => {
    setCourseIdx(idx);
    const course = COURSES[idx];
    const smooth = catmullRom(course.points, 10);
    smoothTrack.current = smooth;

    const startPt = smooth[0];
    const nextPt = smooth[1];
    const angle = Math.atan2(nextPt.y - startPt.y, nextPt.x - startPt.x);
    carRef.current = { x: startPt.x, y: startPt.y, angle, speed: 0, driftAngle: 0, laps: 0, nextCheckpoint: 1 };
    starsRef.current = 0;
    setStars(0);
    setRaceTime(0);
    raceTimeRef.current = 0;
    boostTimer.current = 0;
    trailRef.current = [];

    // spawn items
    const items: Item[] = [];
    for (let i = 0; i < smooth.length; i += Math.floor(smooth.length / 8)) {
      const types: Item["type"][] = ["boost", "oil", "star"];
      const type = types[Math.floor(Math.random() * types.length)];
      const pt = smooth[i];
      const perpAngle = Math.atan2(
        smooth[(i + 1) % smooth.length].y - pt.y,
        smooth[(i + 1) % smooth.length].x - pt.x
      ) + Math.PI / 2;
      const offset = (Math.random() - 0.5) * course.trackWidth * 0.4;
      items.push({
        x: pt.x + Math.cos(perpAngle) * offset,
        y: pt.y + Math.sin(perpAngle) * offset,
        type, timer: 0,
      });
    }
    itemsRef.current = items;
    startTimeRef.current = performance.now() / 1000;
    setScreen("playing");
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { keysRef.current.add(e.key.toLowerCase()); e.preventDefault(); };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useEffect(() => {
    if (screen !== "playing") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const course = COURSES[courseIdx];
    const track = smoothTrack.current;
    const checkpoints = Math.floor(track.length / 4);

    let lastTime = performance.now() / 1000;
    const loop = () => {
      const now = performance.now() / 1000;
      const dt = Math.min(now - lastTime, 0.05);
      lastTime = now;
      raceTimeRef.current = now - startTimeRef.current;
      setRaceTime(Math.floor(raceTimeRef.current * 10) / 10);

      const keys = keysRef.current;
      const touch = touchRef.current;
      const car = carRef.current;

      // Input
      const gas = keys.has("arrowup") || keys.has("w") || touch.gas;
      const brake = keys.has("arrowdown") || keys.has("s") || touch.brake;
      const left = keys.has("arrowleft") || keys.has("a") || touch.steer < -0.2;
      const right = keys.has("arrowright") || keys.has("d") || touch.steer > 0.2;

      // Acceleration
      const maxSpeed = boostTimer.current > 0 ? 280 : 200;
      if (gas) car.speed = Math.min(car.speed + 300 * dt, maxSpeed);
      else if (brake) car.speed = Math.max(car.speed - 400 * dt, -60);
      else car.speed *= 0.98;

      // Steering
      const steerAmount = 2.5 * dt * (car.speed > 0 ? 1 : -1);
      if (left) car.angle -= steerAmount;
      if (right) car.angle += steerAmount;

      // Drift
      const turning = left || right;
      const drifting = turning && Math.abs(car.speed) > 120;
      if (drifting) {
        car.driftAngle += (left ? -1 : 1) * 1.5 * dt;
        car.driftAngle *= 0.95;
      } else {
        car.driftAngle *= 0.9;
      }

      // Movement
      const moveAngle = car.angle + car.driftAngle * 0.3;
      car.x += Math.cos(moveAngle) * car.speed * dt;
      car.y += Math.sin(moveAngle) * car.speed * dt;

      // Trail
      if (drifting && Math.abs(car.speed) > 80) {
        trailRef.current.push({ x: car.x, y: car.y });
        if (trailRef.current.length > 200) trailRef.current.shift();
      }

      // Track boundary (push back towards nearest track point)
      let minDist = Infinity;
      let nearestIdx = 0;
      for (let i = 0; i < track.length; i++) {
        const d = dist(car, track[i]);
        if (d < minDist) { minDist = d; nearestIdx = i; }
      }
      if (minDist > course.trackWidth * 0.55) {
        const tp = track[nearestIdx];
        const pushAngle = Math.atan2(tp.y - car.y, tp.x - car.x);
        const pushDist = minDist - course.trackWidth * 0.5;
        car.x += Math.cos(pushAngle) * pushDist * 0.3;
        car.y += Math.sin(pushAngle) * pushDist * 0.3;
        car.speed *= 0.95;
      }

      // Checkpoints
      const cpIdx = car.nextCheckpoint * checkpoints;
      if (cpIdx < track.length && dist(car, track[cpIdx % track.length]) < course.trackWidth) {
        car.nextCheckpoint++;
        if (car.nextCheckpoint >= 4) {
          car.nextCheckpoint = 0;
          // Check if near start
          if (dist(car, track[0]) < course.trackWidth * 1.5) {
            car.laps++;
            playSound("lap");
            if (car.laps >= TOTAL_LAPS) {
              // Race over
              cancelAnimationFrame(animRef.current);
              setBestTimes((prev) => {
                const next = [...prev];
                if (next[courseIdx] === null || raceTimeRef.current < next[courseIdx]!) {
                  next[courseIdx] = Math.floor(raceTimeRef.current * 10) / 10;
                  localStorage.setItem("topracer_best", JSON.stringify(next));
                }
                return next;
              });
              setScreen("results");
              return;
            }
          }
        }
      }

      // Items
      boostTimer.current = Math.max(0, boostTimer.current - dt);
      for (const item of itemsRef.current) {
        if (item.timer > 0) { item.timer -= dt; continue; }
        if (dist(car, item) < 20) {
          if (item.type === "boost") { boostTimer.current = 2; playSound("boost"); }
          else if (item.type === "oil") { car.speed *= 0.4; car.driftAngle += (Math.random() - 0.5) * 2; }
          else if (item.type === "star") { starsRef.current++; setStars(starsRef.current); playSound("star"); }
          item.timer = 8;
        }
      }

      // Camera
      const camX = car.x - canvas.width / 2;
      const camY = car.y - canvas.height / 2;

      // Draw
      ctx.fillStyle = "#1a2a1a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.translate(-camX, -camY);

      // Track
      ctx.strokeStyle = course.color + "40";
      ctx.lineWidth = course.trackWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(track[0].x, track[0].y);
      for (const p of track) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.stroke();

      // Track center line
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(track[0].x, track[0].y);
      for (const p of track) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Start/finish
      ctx.fillStyle = "#fff";
      ctx.fillRect(track[0].x - 3, track[0].y - course.trackWidth / 2, 6, course.trackWidth);

      // Drift trail
      ctx.strokeStyle = "rgba(100,100,100,0.4)";
      ctx.lineWidth = 3;
      for (let i = 1; i < trailRef.current.length; i++) {
        ctx.beginPath();
        ctx.moveTo(trailRef.current[i - 1].x, trailRef.current[i - 1].y);
        ctx.lineTo(trailRef.current[i].x, trailRef.current[i].y);
        ctx.stroke();
      }

      // Items
      for (const item of itemsRef.current) {
        if (item.timer > 0) continue;
        ctx.beginPath();
        ctx.arc(item.x, item.y, 8, 0, Math.PI * 2);
        if (item.type === "boost") { ctx.fillStyle = "#00E676"; }
        else if (item.type === "oil") { ctx.fillStyle = "#795548"; }
        else { ctx.fillStyle = "#FFD740"; }
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Car
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.angle + car.driftAngle * 0.3);
      // body
      if (boostTimer.current > 0) {
        ctx.shadowColor = "#00E676";
        ctx.shadowBlur = 20;
      }
      ctx.fillStyle = "#FF6B6B";
      ctx.fillRect(-14, -8, 28, 16);
      ctx.fillStyle = "#FFE66D";
      ctx.fillRect(10, -6, 4, 4);
      ctx.fillRect(10, 2, 4, 4);
      // windshield
      ctx.fillStyle = "#4FC3F7";
      ctx.fillRect(2, -5, 6, 10);
      ctx.shadowBlur = 0;
      ctx.restore();

      ctx.restore();

      // HUD
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, canvas.width, 40);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "left";
      ctx.fillText(`Lap ${Math.min(car.laps + 1, TOTAL_LAPS)}/${TOTAL_LAPS}`, 10, 26);
      ctx.textAlign = "center";
      ctx.fillText(`${raceTimeRef.current.toFixed(1)}s`, canvas.width / 2, 26);
      ctx.textAlign = "right";
      ctx.fillText(`⭐${starsRef.current}  ${Math.floor(car.speed)}km/h`, canvas.width - 10, 26);

      if (boostTimer.current > 0) {
        ctx.fillStyle = "#00E676";
        ctx.textAlign = "center";
        ctx.fillText("BOOST!", canvas.width / 2, 60);
      }

      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [screen, courseIdx]);

  // Canvas sizing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.min(800, window.innerWidth - 20);
    const h = Math.min(600, window.innerHeight - 40);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }, [screen]);

  if (screen === "menu") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0d1117, #1a2332, #0d1117)",
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: 20, fontFamily: "'Segoe UI', sans-serif", color: "#fff",
      }}>
        <h1 style={{
          fontSize: "clamp(32px, 6vw, 48px)", fontWeight: 900, marginBottom: 8,
          background: "linear-gradient(90deg, #FF6B6B, #FFE66D, #4ECDC4)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>🏎️ TOP RACER</h1>
        <p style={{ opacity: 0.5, marginBottom: 24 }}>Arrow keys / WASD to drive · {TOTAL_LAPS} laps</p>
        {COURSES.map((c, i) => (
          <button key={i} onClick={() => startRace(i)} style={{
            width: 280, padding: "14px 20px", margin: 6, borderRadius: 12, border: "none",
            background: `linear-gradient(135deg, ${c.color}44, ${c.color}22)`,
            color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer",
          }}>
            {c.name}
            {bestTimes[i] !== null && <span style={{ display: "block", fontSize: 12, opacity: 0.6 }}>Best: {bestTimes[i]}s</span>}
          </button>
        ))}
      </div>
    );
  }

  if (screen === "results") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0d1117, #1a2332)",
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: 20, fontFamily: "'Segoe UI', sans-serif", color: "#fff",
      }}>
        <h2 style={{ fontSize: 28, marginBottom: 8 }}>🏁 Race Complete!</h2>
        <div style={{ fontSize: 48, fontWeight: 900, color: "#FFE66D", marginBottom: 8 }}>
          {raceTime.toFixed(1)}s
        </div>
        <div style={{ fontSize: 18, marginBottom: 24 }}>⭐ Stars: {stars}</div>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={() => startRace(courseIdx)} style={{
            padding: "10px 24px", borderRadius: 10, border: "none",
            background: "linear-gradient(135deg, #4ECDC4, #44a89d)", color: "#fff",
            fontWeight: 700, cursor: "pointer",
          }}>Retry</button>
          <button onClick={() => setScreen("menu")} style={{
            padding: "10px 24px", borderRadius: 10, border: "none",
            background: "rgba(255,255,255,0.1)", color: "#fff",
            fontWeight: 700, cursor: "pointer",
          }}>Menu</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#0d1117",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    }}>
      <canvas ref={canvasRef} style={{ borderRadius: 8, boxShadow: "0 0 30px rgba(78,205,196,0.2)" }} />
      {/* Mobile controls */}
      <div style={{
        display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", justifyContent: "center",
      }}>
        {[
          { label: "◀", action: () => { keysRef.current.add("arrowleft"); setTimeout(() => keysRef.current.delete("arrowleft"), 100); } },
          { label: "▲", action: () => { keysRef.current.add("arrowup"); setTimeout(() => keysRef.current.delete("arrowup"), 100); } },
          { label: "▼", action: () => { keysRef.current.add("arrowdown"); setTimeout(() => keysRef.current.delete("arrowdown"), 100); } },
          { label: "▶", action: () => { keysRef.current.add("arrowright"); setTimeout(() => keysRef.current.delete("arrowright"), 100); } },
        ].map((btn) => (
          <button
            key={btn.label}
            onTouchStart={(e) => { e.preventDefault(); btn.action(); }}
            onMouseDown={btn.action}
            style={{
              width: 56, height: 56, borderRadius: 12, border: "none",
              background: "rgba(255,255,255,0.1)", color: "#fff", fontSize: 24,
              cursor: "pointer", touchAction: "none",
            }}
          >{btn.label}</button>
        ))}
      </div>
    </div>
  );
}
