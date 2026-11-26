/* ============================================================
   구슬 추첨 — 시뮬레이션 모듈 (브라우저 / Node 공용)
   ------------------------------------------------------------
   - 물리 엔진(planck.js)은 인자로 받는다. (브라우저: CDN 전역 planck, 테스트: npm planck)
   - 고정 스텝(1/60초) + 시드 난수(mulberry32)만 사용하므로
     "같은 시드 + 같은 참가 구슬 목록"이면 같은 결과가 다시 나온다. (추첨 기록 검증용)
   - 화면(draw/index.html)은 이 모듈이 만든 상태를 읽어서 그리기만 한다.
   ============================================================ */

export const DT = 1 / 60;
export const MAX_MARBLES_PER_PERSON = 5;
/** 맵/물리 규칙이 바뀌면 올린다. 추첨기록의 비고에 남겨서, 재현할 때 같은 맵으로 뽑은 추첨인지 확인한다 */
export const SIM_VERSION = 3;

/* ── 맵 치수 (월드 단위: 1 = 약 구슬 지름의 2배) ── */
export const WORLD = {
    width:       24,
    marbleR:     0.25,
    goalY:       247,     // 이 선을 넘으면 골인
    hopperTop:   -40,     // 호퍼 벽 윗끝 (구슬이 아무리 많아도 넘치지 않도록 높게)
    funnelY:     4,       // 호퍼가 깔때기로 좁아지기 시작하는 높이
    gateY:       9.3,     // 출발 문 높이
    gateHalfW:   2.3,
    spawnLeft:   1.5,
    spawnRight:  22.5,
    spawnBottom: 3.6,
    slotGap:     0.53,
    rowGap:      0.46,
    timeoutSec:  900,     // 이 시간이 지나면 남은 구슬을 현재 위치(높이)순으로 강제 정리
};

/* ── 난수 (mulberry32) ── */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 시드 난수로 배열을 섞는다 (Fisher–Yates) */
export function seededShuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/* ============================================================
   맵 (모양 데이터) — 물리와 그림이 같은 데이터를 쓴다
   ============================================================ */
export function buildMap() {
    const W = WORLD;

    /* 벽 / 경사: 이어진 선(체인)
       구간 순서(위→아래): 호퍼 → 핀 숲 → 회전 막대 → ① 풍차 숲 → 지그재그 경사 → 핀 흩뿌리기
                          → ② 갈림길(왼쪽 핀 길 / 오른쪽 막대 길) → ③ 병목 관문 → ④ 흔들 판 → 마지막 깔때기 + 십자 */
    const walls = [
        // 왼쪽: 호퍼 벽 → 깔때기 → 배출구 벽 → 천장 → 장애물 구간 왼쪽 벽 → 병목 깔때기
        [[1, W.hopperTop], [1, W.funnelY], [10, 9], [10, 13], [1, 13], [1, 170], [11, 178], [11, 184]],
        // 오른쪽 (좌우 대칭)
        [[23, W.hopperTop], [23, W.funnelY], [14, 9], [14, 13], [23, 13], [23, 170], [13, 178], [13, 184]],
        // 병목 아래 방의 바깥 벽 + 마지막 깔때기와 골인 통로
        [[1, 184], [1, 224], [9, 231], [9, 255]],
        [[23, 184], [23, 224], [15, 231], [15, 255]],
        // 지그재그 경사판 (한쪽 끝은 벽에 닿고 반대쪽 4칸이 열려 있다)
        [[1, 102], [19, 107]],
        [[23, 113], [5, 118]],
        // 가운데로 모으는 V자 깔때기 + 짧은 수직 통로 (옆으로 쏠린 속도를 없애고 가운데에서 갈라지게)
        [[1, 126], [10.5, 132], [10.5, 136]],
        [[23, 126], [13.5, 132], [13.5, 136]],
        // 갈림길 가운데 섬 (마름모)
        [[12, 144], [7.5, 152], [7.5, 159], [12, 167], [16.5, 159], [16.5, 152], [12, 144]],
    ];

    /* 못(고정 원): 가로 2칸 간격, 한 줄씩 어긋나게 */
    const pegs = [];
    const shelves = [];                                   // 벽에서 안쪽으로 내민 짧은 선반 (아래에서 walls 에 합친다)
    for (let row = 0, y = 16; y <= 44; row++, y += 1.75) {
        if (row % 2 === 0) for (let x = 3; x <= 21; x += 2) pegs.push({ x, y, r: 0.3 });
        else               for (let x = 4; x <= 20; x += 2) pegs.push({ x, y, r: 0.3 });
    }
    // 벽 타고 내려오는 길 막기: 벽에서 안쪽으로 비스듬히 내민 짧은 선반 (구슬이 선반을 타고 안쪽으로 굴러 들어간다)
    // 갈림길 왼쪽 길: 못은 성기게(구슬이 끼지 않도록), 벽과 섬 가장자리는 선반으로 번갈아 막는다
    const islandLeft = (y) => (y < 152 ? 12 - (y - 144) * 0.5625 : y <= 159 ? 7.5 : 7.5 + (y - 159) * 0.5625);
    for (let row = 0, y = 147; y <= 168; row++, y += 1.5) {
        const xs = row % 2 === 0 ? [4.2, 6.0] : [5.1, 7.0];
        for (const x of xs) if (x <= islandLeft(y) - 1.4) pegs.push({ x, y, r: 0.25 });
    }
    for (const y of [147.5, 155.5, 163.5]) shelves.push([[1, y], [2.8, y + 1.0]]);                                   // 벽 → 안쪽
    for (const y of [151.5, 159.5, 166]) { const e = islandLeft(y); shelves.push([[e, y], [e - 1.8, y + 1.0]]); }      // 섬 가장자리 → 벽 쪽
    // 갈림길 오른쪽 길: 막대 사이 높이의 벽 쪽 선반
    for (const y of [146.8, 156.8, 167]) shelves.push([[23, y], [21.3, y + 0.95]]);

    /* 회전 막대 (kinematic): hx = 막대 반길이, w = 각속도(rad/s) */
    // 세 줄이 서로 다른 곳을 덮는다: 벽 쪽(1,3줄) / 가운데 + 벽 쪽 작은 막대(2줄) → 어느 x로 떨어져도 한 번은 막대에 닿는다
    const bars = [
        { x: 5,    y: 50, hx: 3.7, w:  1.4 },
        { x: 19,   y: 50, hx: 3.7, w: -1.4 },
        { x: 12,   y: 50, hx: 2.6, w: -1.1 },
        { x: 12,   y: 57, hx: 3.4, w:  1.6 },
        { x: 3.0,  y: 57, hx: 1.9, w: -1.2 },
        { x: 21,   y: 57, hx: 1.9, w:  1.2 },
        { x: 5,    y: 64, hx: 3.7, w: -1.5 },
        { x: 19,   y: 64, hx: 3.7, w:  1.5 },
        { x: 12,   y: 64, hx: 3.2, w: -1.3 },
        // 갈림길 오른쪽 길: 느리게 도는 큰 막대 2개 (끝이 벽·가운데 섬 가까이까지 닿는다)
        { x: 19.75, y: 152, hx: 3.1, w:  1.5 },
        { x: 19.75, y: 162, hx: 3.1, w: -1.7 },
        { x: 19.75, y: 157, hx: 2.9, w:  1.3 },
    ];

    /* ① 풍차 숲: 십자 날개가 서로 다른 속도로 돈다 */
    const windmills = [
        { x: 6.4,  y: 74, hx: 5.2, w:  1.7 },
        { x: 17.6, y: 74, hx: 5.2, w: -1.7 },
        { x: 4.5,  y: 85, hx: 3.8, w: -2.0 },
        { x: 12,   y: 85, hx: 3.8, w:  1.4 },
        { x: 19.5, y: 85, hx: 3.8, w: -2.0 },
        { x: 6.4,  y: 93.5, hx: 5.2, w:  1.5 },
        { x: 17.6, y: 93.5, hx: 5.2, w: -1.5 },
    ];

    /* ④ 흔들 판: 좌우로 천천히 기울어졌다 돌아오는 판 (각도 = amp·sin(f·t + phase)) */
    const sways = [
        { x: 10.6, y: 140, hx: 2.6, amp: 0.75, f: 1.7, phase: 0 },   // 갈림길 꼭짓점 바로 위: 좌우로 고르게 튕긴다
        // ④ 흔들 판: 병목에서 가운데로 떨어진 구슬이 큰 판 3줄을 차례로 만난다 (위상을 다르게 해서 한쪽으로 몰지 않는다)
        { x: 12,   y: 196, hx: 5.4, amp: 0.78, f: 1.25, phase: 0 },
        { x: 6.5,  y: 206, hx: 5.2, amp: 0.78, f: 1.4,  phase: 0 },
        { x: 17.5, y: 206, hx: 5.2, amp: 0.78, f: 1.4,  phase: Math.PI },
        { x: 6.5,  y: 216, hx: 5.2, amp: 0.78, f: 1.1,  phase: 2.1 },
        { x: 17.5, y: 216, hx: 5.2, amp: 0.78, f: 1.1,  phase: 5.2 },
    ];

    /* 골인 직전 회전 십자 (막대 2개가 직각) */
    const spinner = { x: 12, y: 243, hx: 2.8, w: 2.2 };
    const spinner2 = { x: 12, y: 236, hx: 2.8, w: -1.7 };   // 결승 직전 두 번째 십자 (반대 방향)

    const gate = { x: 12, y: W.gateY, hx: W.gateHalfW, hy: 0.2 };

    walls.push(...shelves);
    return { walls, pegs, bars, windmills, sways, spinner, spinner2, gate };
}

/* ============================================================
   당첨 규칙
   ============================================================ */

/**
 * 골인 순서에서 "사람 기준 순위"를 뽑는다.
 *  - 같은 사람의 구슬이 여러 개 들어와도 한 번만 센다 (중복 당첨 방지)
 *  - from === 'front' : 앞에서부터 처음 등장한 순서
 *  - from === 'back'  : 뒤에서부터 처음 등장한 순서
 * spec = { from: 'front' | 'back', start: 1-based, end: 1-based }
 * 아직 결정할 수 없으면 null, 결정되면 [{ rank, key }] (rank는 start~end)
 *
 * @param orderKeys  골인한 순서대로 사람 key 배열
 * @param remaining  아직 골인하지 못한 구슬 수
 * @param remainingKeys  remaining === 1 일 때 그 구슬의 사람 key (마지막 순위는 골인 전에도 확정)
 */
export function decide(orderKeys, remaining, spec, remainingKeys) {
    const { from, start, end } = spec;
    let seq;
    if (from === 'front') {
        seq = orderKeys;
    } else {
        // 뒤에서부터의 순위는 모든 순서가 알려져야 정할 수 있다.
        // 남은 구슬이 1개면 그 구슬이 꼴찌로 확정되므로 골인하지 않아도 된다.
        if (remaining > 1) return null;
        seq = remaining === 1 ? orderKeys.concat(remainingKeys || []) : orderKeys;
        seq = seq.slice().reverse();
    }
    const seen = new Set();
    const distinct = [];
    for (const k of seq) {
        if (seen.has(k)) continue;
        seen.add(k);
        distinct.push(k);
        if (from === 'front' && distinct.length >= end) break;
    }
    if (distinct.length < end) return null;
    return distinct.slice(start - 1, end).map((key, i) => ({ rank: start + i, key }));
}

/** 당첨 조건 검증 → 오류 문자열 또는 null */
export function validateSpec(spec, personCount) {
    if (!spec || (spec.from !== 'front' && spec.from !== 'back')) return '기준(앞/뒤)을 선택해 주세요.';
    if (!Number.isInteger(spec.start) || !Number.isInteger(spec.end)) return '순위는 숫자로 입력해 주세요.';
    if (spec.start < 1 || spec.end < spec.start) return '순위 범위가 올바르지 않습니다.';
    if (spec.end > personCount) return `참가자 수(${personCount}명)보다 큰 순위는 뽑을 수 없습니다.`;
    return null;
}

/** 당첨 조건을 사람이 읽는 문장으로 */
export function describeSpec(spec) {
    const side = spec.from === 'front' ? '앞에서' : '뒤에서';
    if (spec.start === spec.end) {
        if (spec.start === 1) return spec.from === 'front' ? '1등' : '꼴등';
        return `${side} ${spec.start}번째`;
    }
    return `${side} ${spec.start}~${spec.end}번째`;
}

/* ============================================================
   시뮬레이션
   ============================================================ */

/**
 * @param planck        planck.js 모듈 (전역 또는 import)
 * @param opts.seed     32비트 정수 시드
 * @param opts.participants  [{ key, name, count }] count 1~5
 *                      (정렬은 내부에서 key 기준으로 고정하므로 입력 순서는 결과에 영향이 없다)
 */
export function createSim(planck, { seed, participants }) {
    const W = WORLD;
    const rng = mulberry32(seed);
    const { Vec2, World, Circle, Box, Chain } = planck;

    /* ── 구슬 목록 (사람 key 정렬 → 구슬 번호 고정) ── */
    const people = participants.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const marbleDefs = [];
    people.forEach((p, pi) => {
        const c = Math.max(1, Math.min(MAX_MARBLES_PER_PERSON, p.count | 0));
        for (let i = 0; i < c; i++) marbleDefs.push({ key: p.key, name: p.name, person: pi });
    });
    const total = marbleDefs.length;

    /* ── 출발 칸: 아래에서부터 꽉 채워 쌓고, 칸 배정은 시드로 섞는다 (모두 같은 확률) ── */
    const cols = Math.floor((W.spawnRight - W.spawnLeft) / W.slotGap);
    const cx = (W.spawnLeft + W.spawnRight) / 2;           // 호퍼 가운데
    const slots = [];
    for (let row = 0; slots.length < total; row++) {
        const cap = row % 2 === 1 ? cols - 1 : cols;        // 홀수 줄은 반 칸 어긋나므로 1칸 적다
        const n = Math.min(cap, total - slots.length);
        const first = Math.floor((cap - n) / 2);            // 덜 찬 줄도 가운데로 모은다 (한쪽 쏠림 방지)
        for (let i = 0; i < n; i++) {
            slots.push({
                x: cx - ((cap - 1) * W.slotGap) / 2 + (first + i) * W.slotGap,
                y: W.spawnBottom - row * W.rowGap,
            });
        }
    }
    const slotOrder = seededShuffle(slots.map((_, i) => i), rng);

    /* ── 월드 ── */
    const world = new World({ gravity: Vec2(0, 8.2) });
    const map = buildMap();

    const wallOpts = { friction: 0.2, restitution: 0.2 };
    map.walls.forEach((pts) => {
        const body = world.createBody({ type: 'static' });
        body.createFixture(Chain(pts.map(([x, y]) => Vec2(x, y)), false), wallOpts);
    });

    const pegBody = world.createBody({ type: 'static' });
    map.pegs.forEach((p) => {
        pegBody.createFixture(Circle(Vec2(p.x, p.y), p.r), { friction: 0.1, restitution: 0.5 });
    });

    const movers = [];
    map.bars.forEach((b) => {
        const body = world.createBody({ type: 'kinematic', position: Vec2(b.x, b.y) });
        body.createFixture(Box(b.hx, 0.15), { friction: 0.2, restitution: 0.4 });
        body.setAngularVelocity(b.w);
        movers.push({ body, hx: b.hx, hy: 0.15, cross: false });
    });
    map.windmills.forEach((b) => {
        const body = world.createBody({ type: 'kinematic', position: Vec2(b.x, b.y) });
        body.createFixture(Box(b.hx, 0.15), { friction: 0.2, restitution: 0.4 });
        body.createFixture(Box(0.15, b.hx), { friction: 0.2, restitution: 0.4 });
        body.setAngularVelocity(b.w);
        movers.push({ body, hx: b.hx, hy: 0.15, cross: true });
    });
    map.sways.forEach((b) => {
        const body = world.createBody({ type: 'kinematic', position: Vec2(b.x, b.y) });
        body.createFixture(Box(b.hx, 0.15), { friction: 0.2, restitution: 0.4 });
        movers.push({ body, hx: b.hx, hy: 0.15, cross: false, sway: b });
    });
    for (const s of [map.spinner2, map.spinner]) {
        const body = world.createBody({ type: 'kinematic', position: Vec2(s.x, s.y) });
        body.createFixture(Box(s.hx, 0.15), { friction: 0.2, restitution: 0.4 });
        body.createFixture(Box(0.15, s.hx), { friction: 0.2, restitution: 0.4 });
        body.setAngularVelocity(s.w);
        movers.push({ body, hx: s.hx, hy: 0.15, cross: true });
    }

    let gateBody = world.createBody({ type: 'static', position: Vec2(map.gate.x, map.gate.y) });
    gateBody.createFixture(Box(map.gate.hx, map.gate.hy), wallOpts);

    /* ── 구슬 ── */
    const marbles = marbleDefs.map((def, id) => {
        const slot = slots[slotOrder[id]];
        const jitterX = (rng() - 0.5) * 0.02;
        const jitterY = (rng() - 0.5) * 0.02;
        const body = world.createBody({
            type: 'dynamic',
            position: Vec2(slot.x + jitterX, slot.y + jitterY),
            angularDamping: 0.3,
            active: false, // 출발 전에는 비활성 — 시작 버튼을 누르면 한꺼번에 활성화
        });
        body.createFixture(Circle(W.marbleR), { density: 1, friction: 0.2, restitution: 0.35 });
        return {
            id, key: def.key, name: def.name, person: def.person,
            body, finished: false, finishTime: -1,
            // 정지 감시용
            _cx: slot.x, _cy: slot.y, _cT: 0,
        };
    });

    const sim = {
        world, map, movers, marbles, people, total,
        time: 0, steps: 0, started: false,
        finishOrder: [],           // 골인한 구슬 (순서대로)
        active: marbles.slice(),   // 아직 골인하지 못한 구슬
        timedOut: false,
        shakes: 0,
    };

    const destroyQueue = [];

    sim.start = function () {
        if (sim.started) return;
        sim.started = true;
        sim.marbles.forEach((m) => { m.body.setActive(true); m.body.setAwake(true); m._cT = sim.time; });
        world.destroyBody(gateBody);
        gateBody = null;
    };

    /** 한 스텝(1/60초) 진행 */
    sim.step = function () {
        // 이전 스텝에서 골인한 구슬은 월드에서 치운다 (스텝 도중에는 지울 수 없다)
        while (destroyQueue.length) world.destroyBody(destroyQueue.pop());

        // 흔들 판: 다음 스텝에 도달해야 할 각도로 정확히 맞춘다 (누적 오차 없음 → 재현성 유지)
        const tn = (sim.steps + 1) * DT;
        for (const mv of movers) {
            const sw = mv.sway;
            if (!sw) continue;
            const target = sw.amp * Math.sin(sw.f * tn + sw.phase);
            mv.body.setAngularVelocity((target - mv.body.getAngle()) / DT);
        }

        world.step(DT, 8, 3);
        sim.steps++;
        sim.time = sim.steps * DT;
        if (!sim.started) return;

        // 골인 판정 — 같은 스텝에 여럿이 넘으면 더 아래에 있는 구슬이 먼저
        const crossed = [];
        for (const m of sim.active) {
            if (m.body.getPosition().y > W.goalY) crossed.push(m);
        }
        if (crossed.length) {
            crossed.sort((a, b) => b.body.getPosition().y - a.body.getPosition().y || a.id - b.id);
            for (const m of crossed) {
                m.finished = true;
                m.finishTime = sim.time;
                m.finalPos = { x: m.body.getPosition().x, y: m.body.getPosition().y };
                sim.finishOrder.push(m);
                destroyQueue.push(m.body);
            }
            sim.active = sim.active.filter((m) => !m.finished);
        }

        // 정지 감시: 3초(시뮬레이션 시간) 동안 0.3칸도 못 움직이면 살짝 튕겨준다
        if (sim.steps % 30 === 0) {
            for (const m of sim.active) {
                const p = m.body.getPosition();
                if (p.y < W.gateY + 1) { m._cx = p.x; m._cy = p.y; m._cT = sim.time; continue; } // 호퍼 안
                const dx = p.x - m._cx, dy = p.y - m._cy;
                // 진행 감시: 5초 동안 더 아래로 내려가지 못하면(막대·핀 주변을 맴도는 경우) 살짝 튕겨준다
                if (m._maxY === undefined || p.y > m._maxY + 0.4) { m._maxY = p.y; m._pT = sim.time; }
                else if (sim.time - m._pT >= 5) {
                    m.body.applyLinearImpulse(Vec2((rng() - 0.5) * 1.6, -(0.15 + rng() * 0.3)), m.body.getWorldCenter(), true);
                    m._pT = sim.time; sim.shakes++;
                }
                if (dx * dx + dy * dy > 0.09) { m._cx = p.x; m._cy = p.y; m._cT = sim.time; continue; }
                if (sim.time - m._cT >= 3) {
                    m.body.applyLinearImpulse(Vec2((rng() - 0.5) * 3, -(0.6 + rng() * 0.9)), m.body.getWorldCenter(), true);
                    m._cx = p.x; m._cy = p.y; m._cT = sim.time;
                    sim.shakes++;
                }
            }
        }

        // 시간 초과: 남은 구슬을 아래쪽(골인선에 가까운) 순으로 정리
        if (sim.time > W.timeoutSec && sim.active.length) {
            sim.timedOut = true;
            const rest = sim.active.slice().sort((a, b) => b.body.getPosition().y - a.body.getPosition().y || a.id - b.id);
            for (const m of rest) {
                m.finished = true;
                m.finishTime = sim.time;
                m.finalPos = { x: m.body.getPosition().x, y: W.goalY };
                sim.finishOrder.push(m);
                destroyQueue.push(m.body);
            }
            sim.active = [];
        }
    };

    /** 현재까지의 결과. 결정되지 않았으면 null */
    sim.result = function (spec) {
        const keys = sim.finishOrder.map((m) => m.key);
        const rem = sim.active.length;
        const winners = decide(keys, rem, spec, rem === 1 ? [sim.active[0].key] : undefined);
        return winners;
    };

    sim.personByKey = (key) => people.find((p) => p.key === key);

    return sim;
}
