"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";

type GameStatus = "idle" | "running" | "paused" | "failed" | "cleared";
type GameMode = "learning" | "challenge";
type ObstacleType =
  | "pedestrian"
  | "scooter"
  | "puddle"
  | "wall"
  | "car"
  | "flyingRoach"
  | "crawlingRoach"
  | "snail";

type ObstacleLane = "ground" | "mid" | "high";
type FeedbackTone = "good" | "bad" | "wet";

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type PlayerState = {
  umbrellaHeight: number;
  umbrellaTilt: number;
  stepLift: number;
  jumpTimer: number;
  mood: number;
  wetness: number;
  speed: number;
  distance: number;
  boostTimer: number;
  slowTimer: number;
};

type ObstacleSpec = {
  id: number;
  type: ObstacleType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  hit: boolean;
  label: string;
  lane: ObstacleLane;
  outcome?: "hit" | "dodged";
  tutorialPrompted?: boolean;
  tutorialPassed?: boolean;
};

type FeedbackSpec = {
  id: number;
  x: number;
  y: number;
  text: string;
  tone: FeedbackTone;
  ttl: number;
};

type GameSnapshot = {
  status: GameStatus;
  mode: GameMode;
  level: number;
  levelTimer: number;
  completedLearning: boolean;
  player: PlayerState;
  obstacles: ObstacleSpec[];
  feedbacks: FeedbackSpec[];
  message: string;
};

const PLAYER_BODY: Rect = { x: 43, y: 56, w: 10, h: 28 };
const PLAYER_FEET: Rect = { x: 45, y: 82, w: 10, h: 6 };
const LEARNING_COURSE_LENGTH = 84;
const CHALLENGE_LEVEL_DURATION = 13;
const GROUND_BASELINE = 88;
const JUMP_DURATION = 0.9;
const CUE_GAP_MIN = -2;
const CUE_GAP_MAX = 4;
const VEHICLE_DODGE_GRACE = 6;
const VEHICLE_HIT_GRACE = 2.5;
const UMBRELLA_REST_HEIGHT = 56;
const UMBRELLA_RAISED_HEIGHT = 66;
const UMBRELLA_LOWERED_HEIGHT = 46;
const UMBRELLA_HEIGHT_SPEED = 64;

const obstacleCycle: ObstacleType[] = [
  "pedestrian",
  "flyingRoach",
  "puddle",
  "scooter",
  "crawlingRoach",
  "snail",
  "car",
];

const learningObstacles: ObstacleType[] = [
  "puddle",
  "pedestrian",
  "scooter",
  "car",
  "flyingRoach",
  "crawlingRoach",
  "snail",
];

const learningCueGapMax: Partial<Record<ObstacleType, number>> = {
  puddle: 6,
  pedestrian: 18,
  scooter: 12,
  car: 12,
  flyingRoach: 8,
  crawlingRoach: 6,
  snail: 6,
};

const obstacleCopy: Record<ObstacleType, string> = {
  pedestrian: "巷口路人贴脸经过",
  scooter: "带伞电动车横切",
  puddle: "一脚深水坑",
  wall: "湿墙窄道",
  car: "上班车倒计时闯入",
  flyingRoach: "天上飞的蟑螂",
  crawlingRoach: "地上爬的蟑螂",
  snail: "非洲大蜗牛",
};

const initialPlayer: PlayerState = {
  umbrellaHeight: UMBRELLA_REST_HEIGHT,
  umbrellaTilt: 0,
  stepLift: 0,
  jumpTimer: 0,
  mood: 100,
  wetness: 0,
  speed: 1,
  distance: 0,
  boostTimer: 0,
  slowTimer: 0,
};

const initialSnapshot: GameSnapshot = {
  status: "idle",
  mode: "learning",
  level: 1,
  levelTimer: 0,
  completedLearning: false,
  player: initialPlayer,
  obstacles: [],
  feedbacks: [],
  message: "按开始，撑伞钻过广州雨巷。",
};

const initialKeyState = {
  up: false,
  down: false,
  left: false,
  right: false,
  step: false,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const approach = (value: number, target: number, maxDelta: number) => {
  if (value < target) {
    return Math.min(target, value + maxDelta);
  }
  if (value > target) {
    return Math.max(target, value - maxDelta);
  }
  return value;
};

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w &&
  a.x + a.w > b.x &&
  a.y < b.y + b.h &&
  a.y + a.h > b.y;

function umbrellaRect(player: PlayerState): Rect {
  return {
    x: PLAYER_BODY.x - 6 + player.umbrellaTilt * 0.035,
    y: 53 - (player.umbrellaHeight - 56) * 0.06,
    w: 31,
    h: 13,
  };
}

function getObstacleLane(type: ObstacleType): ObstacleLane {
  if (type === "flyingRoach") {
    return "high";
  }
  if (isGroundHazard(type)) {
    return "ground";
  }
  return "mid";
}

const alignToGround = <T extends { h: number }>(obstacle: T) => ({
  ...obstacle,
  y: GROUND_BASELINE - obstacle.h,
});

function getCourseLength(mode: GameMode) {
  return mode === "challenge" ? Number.POSITIVE_INFINITY : LEARNING_COURSE_LENGTH;
}

function getUnlockedLanes(distance: number): ObstacleLane[] {
  if (distance < 28) {
    return ["ground"];
  }
  if (distance < 62) {
    return ["ground", "mid"];
  }
  return ["ground", "mid", "high"];
}

function getNextObstacleType(mode: GameMode, distance: number, index: number) {
  if (mode === "learning") {
    return learningObstacles[index];
  }

  const lanes = getUnlockedLanes(distance);
  const options = obstacleCycle.filter((type) => lanes.includes(getObstacleLane(type)));
  return options[index % options.length] ?? "puddle";
}

function getSpawnDelay(mode: GameMode, type: ObstacleType, distance: number, level: number) {
  if (mode === "learning") {
    return 0.75;
  }

  const baseDelay = distance < 28 ? 2.55 : distance < 62 ? 2.25 : 1.95;
  const levelPressure = Math.min(0.9, (level - 1) * 0.16);
  const tunedDelay = Math.max(0.85, baseDelay - levelPressure);
  if (type === "car" || type === "scooter") {
    return tunedDelay + 0.35;
  }
  if (isGroundHazard(type)) {
    return tunedDelay;
  }
  return tunedDelay + 0.18;
}

function hasPassedPlayer(obstacle: ObstacleSpec) {
  return obstacle.vx < 0
    ? obstacle.x + obstacle.w < PLAYER_BODY.x - 2
    : obstacle.x > PLAYER_BODY.x + PLAYER_BODY.w + 2;
}

function getHitFeedback(type: ObstacleType, effect: ReturnType<typeof collisionEffect>) {
  if (type === "snail") {
    return `蜗牛发光 心情-${effect.mood}`;
  }
  if (type === "scooter") {
    return `电动车水花 湿+${effect.wet} 心-${effect.mood}`;
  }
  if (type === "car") {
    return `汽车水花 湿+${effect.wet} 心-${effect.mood}`;
  }
  const wet = effect.wet > 0 ? `湿度+${effect.wet} ` : "";
  return `${wet}心情-${effect.mood}`;
}

function getDodgeFeedback(type: ObstacleType) {
  if (isGroundHazard(type)) {
    return "跳过 心情+1";
  }
  if (type === "flyingRoach") {
    return "避开飞线 +1";
  }
  if (type === "scooter") {
    return "电动车躲过 无扣分";
  }
  if (type === "car") {
    return "汽车躲过 无扣分";
  }
  return "擦身躲开 +1";
}

function getVehicleDodgeMessage(type: ObstacleType) {
  return type === "car"
    ? "汽车躲过了：这次没有车辆扣分，雨水仍会慢慢累积。"
    : "电动车躲过了：这次没有车辆扣分，雨水仍会慢慢累积。";
}

function createObstacle(type: ObstacleType, id: number): ObstacleSpec {
  const base = {
    id,
    type,
    x: 110,
    y: 70,
    vx: -18,
    vy: 0,
    w: 12,
    h: 12,
    hit: false,
    label: obstacleCopy[type],
    lane: getObstacleLane(type),
  };

  switch (type) {
    case "pedestrian":
      return alignToGround({ ...base, vx: -16, w: 13, h: 29 });
    case "scooter":
      return alignToGround({ ...base, x: -30, vx: 42, w: 28, h: 31 });
    case "puddle":
      return alignToGround({ ...base, vx: -18, w: 22, h: 6 });
    case "wall":
      return alignToGround({ ...base, vx: -17, w: 10, h: 42 });
    case "car":
      return alignToGround({ ...base, x: -34, vx: 50, w: 32, h: 19 });
    case "flyingRoach":
      return { ...base, y: 24, vx: -29, vy: 9, w: 13, h: 12 };
    case "crawlingRoach":
      return alignToGround({ ...base, vx: -24, w: 13, h: 8 });
    case "snail":
      return alignToGround({ ...base, vx: -11, w: 17, h: 12 });
  }
}

function collisionEffect(type: ObstacleType) {
  switch (type) {
    case "pedestrian":
      return { mood: 10, wet: 3, slow: 0.35, boost: 0, message: "伞沿扫到路人，阿公阿嫲眼神杀。" };
    case "scooter":
      return { mood: 18, wet: 10, slow: 0.6, boost: 0, message: "电动车贴伞飞过，水花灌进袖口。" };
    case "puddle":
      return { mood: 8, wet: 16, slow: 0.5, boost: 0, message: "一脚踩进水坑，心情直接扣完一截。" };
    case "wall":
      return { mood: 12, wet: 8, slow: 0.4, boost: 0, message: "伞骨刮墙，雨水顺着墙面反扑。" };
    case "car":
      return { mood: 16, wet: 12, slow: 0.2, boost: 1.6, message: "车灯压过来，被迫 1.5 倍速钻缝。" };
    case "flyingRoach":
      return { mood: 16, wet: 2, slow: 0.2, boost: 0, message: "飞蟑撞伞，整条巷子的压迫感都醒了。" };
    case "crawlingRoach":
      return { mood: 12, wet: 1, slow: 0.25, boost: 0, message: "脚边有什么一闪而过，步伐乱了。" };
    case "snail":
      return { mood: 20, wet: 5, slow: 1, boost: 0, message: "非洲大蜗牛挡路，鞋底和心情一起崩。" };
  }
}

function obstacleRect(obstacle: ObstacleSpec): Rect {
  return { x: obstacle.x, y: obstacle.y, w: obstacle.w, h: obstacle.h };
}

function vehicleImpactRect(obstacle: ObstacleSpec): Rect {
  const sideInset = obstacle.type === "scooter" ? obstacle.w * 0.12 : obstacle.w * 0.08;
  const topInset = obstacle.type === "scooter" ? obstacle.h * 0.18 : obstacle.h * 0.12;
  const bottomInset = obstacle.h * 0.08;

  return {
    x: obstacle.x + sideInset,
    y: obstacle.y + topInset,
    w: obstacle.w - sideInset * 2,
    h: obstacle.h - topInset - bottomInset,
  };
}

function isVehicle(type: ObstacleType) {
  return type === "scooter" || type === "car";
}

function isVehicleDodgeSatisfied(obstacle: ObstacleSpec, player: PlayerState) {
  if (obstacle.type === "scooter") {
    return Math.abs(player.umbrellaTilt) >= 18;
  }
  if (obstacle.type === "car") {
    return Math.abs(player.umbrellaTilt) >= 24;
  }
  return false;
}

function isVehicleInDodgeWindow(obstacle: ObstacleSpec) {
  const vehicle = vehicleImpactRect(obstacle);
  const playerWindow = {
    ...PLAYER_BODY,
    x: PLAYER_BODY.x - VEHICLE_DODGE_GRACE,
    w: PLAYER_BODY.w + VEHICLE_DODGE_GRACE * 2,
  };

  return vehicle.x < playerWindow.x + playerWindow.w && vehicle.x + vehicle.w > playerWindow.x;
}

function isVehicleInHitWindow(obstacle: ObstacleSpec) {
  const vehicle = vehicleImpactRect(obstacle);
  const playerWindow = {
    ...PLAYER_BODY,
    x: PLAYER_BODY.x + VEHICLE_HIT_GRACE,
    w: PLAYER_BODY.w - VEHICLE_HIT_GRACE * 2,
  };

  return vehicle.x < playerWindow.x + playerWindow.w && vehicle.x + vehicle.w > playerWindow.x;
}

function isGroundHazard(type: ObstacleType) {
  return type === "puddle" || type === "crawlingRoach" || type === "snail";
}

function shouldCollide(obstacle: ObstacleSpec, player: PlayerState) {
  const rect = obstacleRect(obstacle);
  const body = PLAYER_BODY;
  const umbrella = umbrellaRect(player);
  const feetLifted = player.stepLift > 0.3;
  const bodyOrUmbrellaHit = intersects(rect, body) || intersects(rect, umbrella);

  if (obstacle.type === "puddle" || obstacle.type === "crawlingRoach" || obstacle.type === "snail") {
    return !feetLifted && intersects(rect, PLAYER_FEET);
  }

  if (obstacle.type === "pedestrian") {
    return player.umbrellaHeight < 62 && bodyOrUmbrellaHit;
  }

  if (obstacle.type === "scooter") {
    return Math.abs(player.umbrellaTilt) < 18 && isVehicleInHitWindow(obstacle) && intersects(vehicleImpactRect(obstacle), body);
  }

  if (obstacle.type === "car") {
    return Math.abs(player.umbrellaTilt) < 24 && isVehicleInHitWindow(obstacle) && intersects(vehicleImpactRect(obstacle), body);
  }

  if (obstacle.type === "wall") {
    const umbrellaIsFoldedThrough = Math.abs(player.umbrellaTilt) > 20 && player.umbrellaHeight > 42;
    return (intersects(rect, umbrella) && !umbrellaIsFoldedThrough) || intersects(rect, body);
  }

  if (obstacle.type === "flyingRoach") {
    return player.umbrellaTilt < 20 && bodyOrUmbrellaHit;
  }

  return bodyOrUmbrellaHit;
}

function isJumpClearingGroundObstacle(obstacle: ObstacleSpec, player: PlayerState) {
  if (!isGroundHazard(obstacle.type) || player.stepLift <= 0.18) {
    return false;
  }

  const rect = obstacleRect(obstacle);
  const feetLane = {
    ...PLAYER_FEET,
    x: PLAYER_FEET.x - 6,
    w: PLAYER_FEET.w + 12,
  };

  return rect.x < feetLane.x + feetLane.w && rect.x + rect.w > feetLane.x;
}

function getHorizontalGapToPlayer(obstacle: ObstacleSpec) {
  return obstacle.vx < 0
    ? obstacle.x - (PLAYER_BODY.x + PLAYER_BODY.w)
    : PLAYER_BODY.x - (obstacle.x + obstacle.w);
}

function isInDodgeCueZone(obstacle: ObstacleSpec) {
  const gap = getHorizontalGapToPlayer(obstacle);
  return gap >= CUE_GAP_MIN && gap <= CUE_GAP_MAX;
}

function isInLearningCueZone(obstacle: ObstacleSpec) {
  const gap = getHorizontalGapToPlayer(obstacle);
  const cueGapMax = learningCueGapMax[obstacle.type] ?? CUE_GAP_MAX;
  return gap >= CUE_GAP_MIN && gap <= cueGapMax;
}

function getTutorialObstacle(obstacles: ObstacleSpec[]) {
  const next = obstacles
    .filter((obstacle) => !obstacle.hit && !obstacle.tutorialPassed)
    .sort((a, b) => a.id - b.id)[0];

  if (!next) {
    return undefined;
  }

  return isInLearningCueZone(next) ? next : undefined;
}

function isLearningObstacleComplete(obstacle: ObstacleSpec) {
  return Boolean(obstacle.outcome || obstacle.hit || hasPassedPlayer(obstacle));
}

function getChallengeEnding(player: PlayerState, level: number) {
  if (player.wetness >= 100) {
    return `湿透结局：闯到第 ${level} 关，雨水把整个人浇到投降。`;
  }
  if (player.mood <= 0) {
    return `破防结局：闯到第 ${level} 关，心情先一步耗尽。`;
  }
  return `巷口结局：闯到第 ${level} 关。`;
}

function isTutorialActionSatisfied(
  type: ObstacleType,
  player: PlayerState,
  keys: typeof initialKeyState,
  lastAction: keyof typeof initialKeyState | null,
) {
  switch (type) {
    case "flyingRoach":
      return lastAction === "right" || keys.right || player.umbrellaTilt >= 20;
    case "puddle":
    case "crawlingRoach":
    case "snail":
      return lastAction === "step" || keys.step || player.stepLift > 0.45;
    case "pedestrian":
      return lastAction === "up" || keys.up || player.umbrellaHeight >= 62;
    case "scooter":
      return lastAction === "right" || lastAction === "left" || keys.right || keys.left || Math.abs(player.umbrellaTilt) >= 20;
    case "car":
      return lastAction === "left" || lastAction === "right" || keys.left || keys.right || Math.abs(player.umbrellaTilt) >= 24;
    case "wall":
      return lastAction === "left" || lastAction === "right" || keys.left || keys.right || Math.abs(player.umbrellaTilt) >= 20;
  }
}

function isLearningVehicleTutorialSatisfied(lastAction: keyof typeof initialKeyState | null) {
  return lastAction === "left" || lastAction === "right";
}

function getTutorialCue(snapshot: GameSnapshot) {
  if (snapshot.status !== "running") {
    return {
      title: snapshot.completedLearning ? "选择模式" : "简单版教学",
      action: snapshot.completedLearning ? "学习 / 闯关" : "点「开始学习」",
      detail: snapshot.completedLearning ? "正式进入游戏前，选一个模式。" : "障碍快贴近主角时再提示该按哪个键。",
      tone: "ready",
    };
  }

  if (snapshot.mode === "challenge") {
    return {
      title: "闯关模式",
      action: `第 ${snapshot.level} 关`,
      detail: "速度和密度会随关卡上升，尽量撑到最后。",
      tone: "ready",
    };
  }

  const gate = getTutorialObstacle(snapshot.obstacles);
  const incoming = snapshot.obstacles
    .filter((obstacle) => !obstacle.hit && isInDodgeCueZone(obstacle))
    .sort((a, b) => getHorizontalGapToPlayer(a) - getHorizontalGapToPlayer(b))[0];
  const target = gate ?? incoming;

  if (!target) {
    return {
      title: "看准再出招",
      action: "等障碍贴近",
      detail: "按键提示会在快碰到主角时出现。",
      tone: "ready",
    };
  }

  const pauseDetail = gate ? "画面已暂停，做对动作后继续播放。" : "";

  switch (target.type) {
    case "flyingRoach":
      return {
        title: "右侧飞蟑",
        action: "按住 右斜 / D",
        detail: pauseDetail || "蟑螂从右边飞来，把伞朝右斜过去挡。",
        tone: "sky",
      };
    case "puddle":
    case "crawlingRoach":
    case "snail":
      return {
        title: target.type === "puddle" ? "地上水坑" : target.type === "snail" ? "非洲大蜗牛" : "地上爬蟑",
        action: "按 跳 / Space",
        detail: pauseDetail || "跳起来就能躲过低位障碍。",
        tone: "ground",
      };
    case "pedestrian":
      return {
        title: "中间层：路人",
        action: "按住 升伞 / W / ↑",
        detail: pauseDetail || "有人经过时按住升伞，让出头顶空间；松手会自动回到正常高度。",
        tone: "people",
      };
    case "scooter":
      return {
        title: "中间层：电动车",
        action: "按住 斜伞 / A 或 D",
        detail: pauseDetail || "别点一下就松，按住 A 或 D 把伞斜开，等电动车整辆过完再放。",
        tone: "vehicle",
      };
    case "car":
      return {
        title: "中间层：汽车",
        action: "按住 斜伞 / A 或 D",
        detail: pauseDetail || "汽车从左侧压过来，按住 A 或 D 把伞斜开，看到“擦身躲开”再松。",
        tone: "vehicle",
      };
    case "wall":
      return {
        title: "窄墙",
        action: "按住 左斜或右斜 / A 或 D",
        detail: "这一关暂时不会刷墙。",
        tone: "vehicle",
      };
  }
}

function ObstacleFigure({ type }: { type: ObstacleType }) {
  const assets: Record<ObstacleType, string> = {
    pedestrian: "pedestrian",
    scooter: "scooter",
    puddle: "puddle",
    wall: "puddle",
    car: "car",
    flyingRoach: "flying-roach",
    crawlingRoach: "crawling-roach",
    snail: "snail",
  };

  return (
    <Image
      className="sprite-img"
      src={`/assets/sprites/${assets[type]}.png`}
      alt=""
      fill
      sizes="160px"
      unoptimized
      draggable={false}
    />
  );
}

function getObstacleHint(type: ObstacleType) {
  if (type === "flyingRoach") {
    return { label: "右来", action: "右斜", className: "hint-sky" };
  }
  if (isGroundHazard(type)) {
    return { label: "地面", action: "跳", className: "hint-ground" };
  }
  if (type === "pedestrian") {
    return { label: "路人", action: "升伞", className: "hint-people" };
  }
  if (isVehicle(type)) {
    return { label: "横切", action: "按住斜伞", className: "hint-vehicle" };
  }
  return { label: "窄道", action: "斜伞", className: "hint-vehicle" };
}

function Obstacle({ obstacle }: { obstacle: ObstacleSpec }) {
  const hint = getObstacleHint(obstacle.type);
  const verticalStyle =
    obstacle.type === "flyingRoach"
      ? { top: `${obstacle.y}%` }
      : { bottom: `${100 - GROUND_BASELINE}%` };

  return (
    <div
      className={`obstacle obstacle-${obstacle.type} ${obstacle.hit ? "is-hit" : ""} ${
        obstacle.outcome ? `is-${obstacle.outcome}` : ""
      }`}
      style={{
        left: `${obstacle.x}%`,
        width: `${obstacle.w}%`,
        height: `${obstacle.h}%`,
        ...verticalStyle,
      }}
      aria-label={obstacle.label}
    >
      <span className={`hazard-lane ${hint.className}`} />
      <span className={`hazard-fx fx-${obstacle.type}`} />
      <ObstacleFigure type={obstacle.type} />
      <span className={`obstacle-label ${hint.className}`}>{hint.label} · {hint.action}</span>
    </div>
  );
}

function StatBar({ label, value, tone }: { label: string; value: number; tone: "mood" | "wet" }) {
  return (
    <div className="stat-row">
      <div className="stat-label">
        <span>{label}</span>
        <strong>{Math.round(value)}</strong>
      </div>
      <div className="stat-track">
        <div className={`stat-fill ${tone}`} style={{ width: `${clamp(value, 0, 100)}%` }} />
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onDown,
  onUp,
}: {
  label: string;
  onDown: () => void;
  onUp: () => void;
}) {
  return (
    <button
      className="control-button"
      type="button"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={onUp}
    >
      {label}
    </button>
  );
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(initialSnapshot);
  const stateRef = useRef<GameSnapshot>(initialSnapshot);
  const keysRef = useRef({ ...initialKeyState });
  const lastActionRef = useRef<keyof typeof initialKeyState | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const spawnTimerRef = useRef(0.8);
  const obstacleIndexRef = useRef(0);
  const idRef = useRef(1);
  const feedbackIdRef = useRef(1);
  const stepPressedRef = useRef(false);
  const wetFeedbackTimerRef = useRef(0);
  const passiveWetRef = useRef(0);
  const passiveMoodRef = useRef(0);

  const progress = useMemo(
    () =>
      snapshot.mode === "challenge"
        ? clamp((snapshot.levelTimer / CHALLENGE_LEVEL_DURATION) * 100, 0, 100)
        : clamp((snapshot.player.distance / LEARNING_COURSE_LENGTH) * 100, 0, 100),
    [snapshot.levelTimer, snapshot.mode, snapshot.player.distance],
  );

  const startGame = (mode: GameMode) => {
    const completedLearning = stateRef.current.completedLearning || mode === "challenge";
    const next = {
      status: "running" as GameStatus,
      mode,
      level: 1,
      levelTimer: 0,
      completedLearning,
      player: { ...initialPlayer },
      obstacles: [],
      feedbacks: [],
      message: mode === "learning" ? "学习模式：先看提示，再做动作。" : "闯关模式：雨势开大，难度会逐关升。",
    };
    spawnTimerRef.current = mode === "learning" ? 0.25 : 0.85;
    obstacleIndexRef.current = 0;
    feedbackIdRef.current = 1;
    stepPressedRef.current = false;
    wetFeedbackTimerRef.current = 0;
    passiveWetRef.current = 0;
    passiveMoodRef.current = 0;
    keysRef.current = { ...initialKeyState };
    lastActionRef.current = null;
    stateRef.current = next;
    setSnapshot(next);
  };

  const restartCurrentMode = () => {
    startGame(snapshot.mode);
  };

  const setKey = (key: keyof typeof keysRef.current, value: boolean) => {
    keysRef.current[key] = value;
    if (value) {
      lastActionRef.current = key;
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Enter" && stateRef.current.status !== "running") {
        startGame(stateRef.current.completedLearning ? "challenge" : "learning");
      }
      if (event.code === "Escape" && stateRef.current.status === "running") {
        stateRef.current = { ...stateRef.current, status: "paused", message: "雨声暂停，巷子还在等你。" };
        setSnapshot(stateRef.current);
      }
      if (event.code === "Space") setKey("step", true);
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") setKey("up", true);
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "s") setKey("down", true);
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") setKey("left", true);
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") setKey("right", true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setKey("step", false);
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") setKey("up", false);
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "s") setKey("down", false);
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") setKey("left", false);
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") setKey("right", false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const tick = (time: number) => {
      const previous = lastTimeRef.current || time;
      const dt = clamp((time - previous) / 1000, 0, 0.04);
      lastTimeRef.current = time;

      const current = stateRef.current;
      if (current.status === "running") {
        const keys = keysRef.current;
        const player = { ...current.player };
        let level = current.level;
        let levelTimer = current.levelTimer;
        let message = current.message;
        const feedbacks = current.feedbacks
          .map((feedback) => ({ ...feedback, ttl: feedback.ttl - dt }))
          .filter((feedback) => feedback.ttl > 0);

        const umbrellaHeightTarget = keys.up
          ? UMBRELLA_RAISED_HEIGHT
          : keys.down
            ? UMBRELLA_LOWERED_HEIGHT
            : UMBRELLA_REST_HEIGHT;
        player.umbrellaHeight = approach(player.umbrellaHeight, umbrellaHeightTarget, UMBRELLA_HEIGHT_SPEED * dt);
        if (keys.left) player.umbrellaTilt -= 82 * dt;
        if (keys.right) player.umbrellaTilt += 82 * dt;
        if (!keys.left && !keys.right) player.umbrellaTilt *= 1 - 5 * dt;
        if (keys.step && !stepPressedRef.current && player.jumpTimer <= 0) {
          player.jumpTimer = JUMP_DURATION;
        }
        stepPressedRef.current = keys.step;

        player.umbrellaHeight = clamp(player.umbrellaHeight, UMBRELLA_LOWERED_HEIGHT, UMBRELLA_RAISED_HEIGHT);
        player.umbrellaTilt = clamp(player.umbrellaTilt, -36, 36);
        if (player.jumpTimer > 0) {
          player.jumpTimer = Math.max(0, player.jumpTimer - dt);
          const jumpProgress = 1 - player.jumpTimer / JUMP_DURATION;
          player.stepLift = Math.sin(jumpProgress * Math.PI);
        } else {
          player.stepLift = 0;
        }
        player.boostTimer = Math.max(0, player.boostTimer - dt);
        player.slowTimer = Math.max(0, player.slowTimer - dt);
        const challengeSpeed = current.mode === "challenge" ? (level - 1) * 0.1 : 0;
        player.speed = clamp(1 + challengeSpeed + (player.boostTimer > 0 ? 0.55 : 0) - (player.slowTimer > 0 ? 0.32 : 0), 0.68, 2.25);

        const gate = current.mode === "learning" ? getTutorialObstacle(current.obstacles) : undefined;
        const tutorialSolved = gate && (
          isVehicle(gate.type)
            ? gate.tutorialPrompted && isLearningVehicleTutorialSatisfied(lastActionRef.current)
            : isTutorialActionSatisfied(gate.type, player, keys, lastActionRef.current)
        );
        const tutorialWaiting = gate && (!gate.tutorialPrompted || !tutorialSolved);

        if (tutorialWaiting) {
          player.speed = 0;
          message = "教学暂停：先按对动作，巷子才继续动。";
          const promptedObstacles = gate && !gate.tutorialPrompted
            ? current.obstacles.map((obstacle) =>
                obstacle.id === gate.id ? { ...obstacle, tutorialPrompted: true } : obstacle,
              )
            : current.obstacles;
          if (gate && !gate.tutorialPrompted) {
            lastActionRef.current = null;
          }
          stateRef.current = { ...current, player, level, levelTimer, obstacles: promptedObstacles, feedbacks, message };
        } else {
          const sourceObstacles = gate
            ? current.obstacles.map((obstacle) =>
                obstacle.id === gate?.id
                  ? { ...obstacle, tutorialPassed: true, outcome: isVehicle(obstacle.type) ? "dodged" as const : obstacle.outcome }
                  : obstacle,
              )
            : current.obstacles;
          if (tutorialSolved) {
            if (gate && isVehicle(gate.type)) {
              message = getVehicleDodgeMessage(gate.type);
              wetFeedbackTimerRef.current = 0;
              passiveWetRef.current = 0;
              passiveMoodRef.current = 0;
              feedbacks.push({
                id: feedbackIdRef.current++,
                x: gate.x + gate.w * 0.5,
                y: gate.y - 3,
                text: getDodgeFeedback(gate.type),
                tone: "good",
                ttl: 1,
              });
            }
            lastActionRef.current = null;
          }

          const courseLength = getCourseLength(current.mode);
          player.distance = current.mode === "challenge"
            ? player.distance + dt * 5.2 * player.speed
            : clamp(player.distance + dt * 5.2 * player.speed, 0, courseLength);

          if (current.mode === "challenge") {
            levelTimer += dt;
            if (levelTimer >= CHALLENGE_LEVEL_DURATION) {
              level += 1;
              levelTimer -= CHALLENGE_LEVEL_DURATION;
              feedbacks.push({
                id: feedbackIdRef.current++,
                x: PLAYER_BODY.x + 8,
                y: PLAYER_BODY.y - 10,
                text: `第 ${level} 关`,
                tone: "wet",
                ttl: 1.4,
              });
              message = `第 ${level} 关：雨巷更挤了。`;
            }
          }

          const wetRate = player.umbrellaHeight > 62 ? 1.2 : player.umbrellaHeight < 50 ? 0.35 : 0.55;
          const wetDelta = dt * wetRate;
          player.wetness = clamp(player.wetness + wetDelta, 0, 100);

          const moodDelta = dt * (player.wetness > 75 ? 1.2 : 0.35);
          player.mood = clamp(player.mood - moodDelta, 0, 100);

          passiveWetRef.current += wetDelta;
          passiveMoodRef.current += moodDelta;
          wetFeedbackTimerRef.current += dt;
          if (wetFeedbackTimerRef.current >= 2) {
            const wetPoints = Math.max(1, Math.round(passiveWetRef.current));
            const moodPoints = Math.max(1, Math.round(passiveMoodRef.current));
            feedbacks.push({
              id: feedbackIdRef.current++,
              x: PLAYER_BODY.x + 7,
              y: PLAYER_BODY.y + 2,
              text: `雨淋 湿度+${wetPoints} 心情-${moodPoints}`,
              tone: "wet",
              ttl: 1.35,
            });
            wetFeedbackTimerRef.current = 0;
            passiveWetRef.current = 0;
            passiveMoodRef.current = 0;
          }

          spawnTimerRef.current -= dt;
          const obstacles = sourceObstacles
            .map((obstacle) => ({
              ...obstacle,
              x: obstacle.x + obstacle.vx * dt * player.speed,
              y:
                obstacle.type === "flyingRoach"
                  ? obstacle.y + Math.sin(time / 130 + obstacle.id) * 0.12 + obstacle.vy * dt
                  : obstacle.y,
            }))
            .filter((obstacle) => (obstacle.vx > 0 ? obstacle.x < 132 : obstacle.x > -34) && obstacle.y < 95);

          if (spawnTimerRef.current <= 0) {
            const type = getNextObstacleType(current.mode, player.distance, obstacleIndexRef.current);
            const canSpawnLearningObstacle = current.mode === "challenge" || (
              type &&
              obstacles.every(isLearningObstacleComplete)
            );

            if (type && canSpawnLearningObstacle) {
              obstacles.push(createObstacle(type, idRef.current++));
              obstacleIndexRef.current += 1;
            }
            spawnTimerRef.current = type ? getSpawnDelay(current.mode, type, player.distance, level) : 0.5;
          }

          for (const obstacle of obstacles) {
            if (!obstacle.hit && !obstacle.outcome && isJumpClearingGroundObstacle(obstacle, player)) {
              obstacle.outcome = "dodged";
              player.mood = clamp(player.mood + 1, 0, 100);
              feedbacks.push({
                id: feedbackIdRef.current++,
                x: obstacle.x + obstacle.w * 0.5,
                y: obstacle.y - 3,
                text: getDodgeFeedback(obstacle.type),
                tone: "good",
                ttl: 1,
              });
            }
          }

          for (const obstacle of obstacles) {
            if (
              !obstacle.hit &&
              !obstacle.outcome &&
              isVehicle(obstacle.type) &&
              isVehicleInDodgeWindow(obstacle) &&
              isVehicleDodgeSatisfied(obstacle, player)
            ) {
              obstacle.outcome = "dodged";
              player.mood = clamp(player.mood + 1, 0, 100);
              message = getVehicleDodgeMessage(obstacle.type);
              wetFeedbackTimerRef.current = 0;
              passiveWetRef.current = 0;
              passiveMoodRef.current = 0;
              feedbacks.push({
                id: feedbackIdRef.current++,
                x: obstacle.x + obstacle.w * 0.5,
                y: obstacle.y - 3,
                text: getDodgeFeedback(obstacle.type),
                tone: "good",
                ttl: 1,
              });
            }
          }

          for (const obstacle of obstacles) {
            const blocksLearningDamage = current.mode === "learning" && (!obstacle.tutorialPassed || isVehicle(obstacle.type));
            if (!obstacle.hit && !obstacle.outcome && !blocksLearningDamage && shouldCollide(obstacle, player)) {
              obstacle.hit = true;
              obstacle.outcome = "hit";
              const effect = collisionEffect(obstacle.type);
              player.mood = clamp(player.mood - effect.mood, 0, 100);
              player.wetness = clamp(player.wetness + effect.wet, 0, 100);
              player.slowTimer = Math.max(player.slowTimer, effect.slow);
              player.boostTimer = Math.max(player.boostTimer, effect.boost);
              feedbacks.push({
                id: feedbackIdRef.current++,
                x: obstacle.x + obstacle.w * 0.5,
                y: obstacle.y - 2,
                text: getHitFeedback(obstacle.type, effect),
                tone: "bad",
                ttl: 1.2,
              });
              message = effect.message;
            }
          }

          for (const obstacle of obstacles) {
            if (!obstacle.hit && !obstacle.outcome && hasPassedPlayer(obstacle)) {
              obstacle.outcome = "dodged";
              player.mood = clamp(player.mood + 1, 0, 100);
              feedbacks.push({
                id: feedbackIdRef.current++,
                x: obstacle.x + obstacle.w * 0.5,
                y: obstacle.y - 3,
                text: getDodgeFeedback(obstacle.type),
                tone: "good",
                ttl: 1,
              });
            }
          }

          let status: GameStatus = "running";
          if (player.mood <= 0 || player.wetness >= 100) {
            status = "failed";
            message = current.mode === "challenge"
              ? getChallengeEnding(player, level)
              : "伞没收住，雨巷把人淋到破防。";
          } else if (
            current.mode === "learning" &&
            obstacleIndexRef.current >= learningObstacles.length &&
            obstacles.every(isLearningObstacleComplete)
          ) {
            status = "cleared";
            message = "学习完成，可以正式进巷子了。";
          }

          stateRef.current = {
            status,
            mode: current.mode,
            level,
            levelTimer,
            completedLearning: current.completedLearning || (current.mode === "learning" && status === "cleared"),
            player,
            obstacles,
            feedbacks,
            message,
          };
        }
        setSnapshot(stateRef.current);
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const player = snapshot.player;
  const umbrella = umbrellaRect(player);
  const tutorialCue = getTutorialCue(snapshot);

  return (
    <main className="game-shell">
      <section className="stage-card" aria-label="雨天走巷子可玩 Demo">
        <div className="stage-topbar">
          <div>
            <p className="eyebrow">NEON RAIN ALLEY</p>
            <h1>雨天走巷子</h1>
          </div>
          <button className="primary-action" type="button" onClick={restartCurrentMode}>
            {snapshot.status === "idle" && !snapshot.completedLearning ? "开始学习" : "重开"}
          </button>
        </div>

        <div className="phone-frame">
          <div className={`game-scene scene-${tutorialCue.tone}`}>
            <div className="scene-depth" />
            <div className="neon-sign sign-one">雨天</div>
            <div className="neon-sign sign-two">走巷</div>
            <div className="window-grid" />
            <div className="rain-layer rain-layer-back" />
            <div className="rain-layer rain-layer-front" />
            <div className="road-glow" />

            <div className="hud-panel">
              <StatBar label="心情" value={player.mood} tone="mood" />
              <StatBar label="湿度" value={player.wetness} tone="wet" />
              <div className="mini-metrics">
                <span>{snapshot.mode === "challenge" ? `第 ${snapshot.level} 关` : "学习"}</span>
                <span>倾角 {Math.round(player.umbrellaTilt)}°</span>
                <span>{player.speed.toFixed(1)}x</span>
              </div>
              <div className="progress-track">
                <div style={{ width: `${progress}%` }} />
              </div>
            </div>

            {snapshot.obstacles.map((obstacle) => (
              <Obstacle key={obstacle.id} obstacle={obstacle} />
            ))}

            {snapshot.feedbacks.map((feedback) => (
              <span
                key={feedback.id}
                className={`feedback-float feedback-${feedback.tone}`}
                style={{
                  left: `${feedback.x}%`,
                  top: `${feedback.y}%`,
                }}
              >
                {feedback.text}
              </span>
            ))}

            <div
              className="player"
              style={{
                left: `${PLAYER_BODY.x}%`,
                top: `${PLAYER_BODY.y}%`,
              }}
            >
              <Image
                className={`player-sprite ${player.stepLift > 0.35 ? "is-lifted" : ""}`}
                src="/assets/sprites/player-body.png"
                alt="撑伞走巷子的玩家"
                style={{
                transform: `translateY(${-34 * player.stepLift}%) rotate(${-7 * player.stepLift}deg)`,
              }}
              fill
              sizes="96px"
                priority
                unoptimized
                draggable={false}
              />
            </div>

            <div
              className="umbrella"
              style={{
                left: `${umbrella.x}%`,
                top: `${umbrella.y}%`,
                transform: `rotate(${player.umbrellaTilt}deg)`,
              }}
            >
              <Image
                className="umbrella-sprite"
                src="/assets/sprites/umbrella.png"
                alt="雨伞"
                fill
                sizes="180px"
                priority
                unoptimized
                draggable={false}
              />
            </div>

            <div className="message-strip" hidden>
              {snapshot.message}
            </div>

            <div className={`tutorial-cue cue-${tutorialCue.tone} ${snapshot.message.startsWith("教学暂停") ? "is-paused" : ""}`}>
              <span>{tutorialCue.title}</span>
              <strong>{tutorialCue.action}</strong>
              <p>{tutorialCue.detail}</p>
            </div>

            {snapshot.status !== "running" && (
              <div className="state-overlay">
                {snapshot.completedLearning ? (
                  <>
                    <p>{snapshot.status === "failed" ? "闯关结果" : "模式选择"}</p>
                    <strong>
                      {snapshot.mode === "challenge" && snapshot.status !== "idle"
                        ? snapshot.message
                        : "学习完成。现在正式选择要怎么进巷子。"}
                    </strong>
                    {snapshot.mode === "challenge" && snapshot.status !== "idle" && (
                      <span className="result-badge">最终关数：第 {snapshot.level} 关</span>
                    )}
                    <div className="mode-actions">
                      <button type="button" onClick={() => startGame("challenge")}>
                        闯关模式
                      </button>
                      <button type="button" onClick={() => startGame("learning")}>
                        学习模式
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>学习模式</p>
                    <strong>
                      {snapshot.status === "idle" ? "先把地面、高处、行人和车辆各练一遍。" : snapshot.message}
                    </strong>
                    <button type="button" onClick={() => startGame("learning")}>
                      开始学习
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="touch-controls" aria-label="移动端操控">
              <div className="control-cluster">
                <ControlButton label="升伞" onDown={() => setKey("up", true)} onUp={() => setKey("up", false)} />
                <ControlButton label="降伞" onDown={() => setKey("down", true)} onUp={() => setKey("down", false)} />
              </div>
              <ControlButton label="跳" onDown={() => setKey("step", true)} onUp={() => setKey("step", false)} />
              <div className="control-cluster">
                <ControlButton label="左斜" onDown={() => setKey("left", true)} onUp={() => setKey("left", false)} />
                <ControlButton label="右斜" onDown={() => setKey("right", true)} onUp={() => setKey("right", false)} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside className="desktop-panel">
        <div>
          <p className="eyebrow">CONTROL</p>
          <h2>撑伞穿行</h2>
        </div>
        <div className="panel-grid">
          <span>W / ↑</span>
          <p>按住升伞，给路人让头顶空间；松手回中位</p>
          <span>S / ↓</span>
          <p>按住低伞，少淋一点雨；松手回中位</p>
          <span>A D</span>
          <p>按住斜伞，等电动车或汽车完整过身再放</p>
          <span>Space</span>
          <p>跳起，躲水坑和地面障碍</p>
        </div>
        <div className="threat-list">
          {obstacleCycle.map((type) => (
            <div key={type}>
              <strong>{obstacleCopy[type]}</strong>
              <span>{type === "car" ? "强压迫" : type === "wall" ? "看倾角" : type === "flyingRoach" ? "看来向" : type === "pedestrian" ? "升伞" : type.includes("Roach") ? "地面线" : "基础障碍"}</span>
            </div>
          ))}
        </div>
        <p className="build-note">
          竖屏为主，桌面保持手机画幅；这一版先把玩法骨架、氛围和障碍类型跑通。
        </p>
      </aside>
    </main>
  );
}
