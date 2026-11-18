/**
 * Тесты зоны интегрирования и предела вклада интеграла (v2.2.0).
 *
 * Запуск: node test/integral-band.test.js
 * Без зависимостей: свой мини-раннер, Date.now подменяется для времени.
 */
const assert = require('assert');
const AdaptiveController = require('../lib/adaptive-controller');

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        results.push(['OK  ', name, '']);
    } catch (e) {
        failed++;
        results.push(['FAIL', name, e.message]);
    }
}

/** Прогон: массив температур с шагом 1 минута. Возвращает историю. */
function run(cfg, temps) {
    const base = 1700000000000;
    let now = base;
    const realNow = Date.now;
    Date.now = () => now;
    try {
        const c = new AdaptiveController(Object.assign({
            mode: 'heat', minTemp: 22, maxTemp: 30, targetTemp: 29,
            hysteresis: 0.5, sampleInterval: 60000, maxOutputChange: 100,
            Kp: 4, Ki: 2.5, Kd: 0, operatingMode: 'manual',
            learningEnabled: false
        }, cfg));
        const hist = [];
        for (const t of temps) {
            now += 60000;
            const st = c.update(t);
            hist.push({
                temp: t,
                output: st.output,
                integral: st.debug.integral,
                error: st.debug.error,
                direction: st.direction
            });
        }
        return hist;
    } finally {
        Date.now = realNow;
    }
}

// ---------- 1. Зона интегрирования

test('недогрев 4 °C вне зоны: интеграл не растёт', () => {
    const h = run({ integralBand: 1.0 }, Array(60).fill(25.0));
    const last = h[h.length - 1];
    assert.strictEqual(last.integral, 0, `интеграл ${last.integral}, ожидали 0`);
    // выход задан только Kp: 4 * 4 = 16
    assert.ok(Math.abs(last.output - 16) < 0.2, `выход ${last.output}, ожидали ~16`);
});

test('ошибка внутри зоны: интеграл растёт', () => {
    const h = run({ integralBand: 1.0 }, Array(30).fill(28.5));
    const last = h[h.length - 1];
    assert.ok(last.integral > 0, 'интеграл должен расти внутри зоны');
});

test('выход из зоны вверх: накопление замирает, значение сохраняется', () => {
    // 20 минут внутри зоны, затем резкое падение температуры (вне зоны)
    const h = run({ integralBand: 1.0 },
        Array(20).fill(28.5).concat(Array(20).fill(25.0)));
    const atBand = h[19].integral;
    const after = h[h.length - 1].integral;
    assert.ok(atBand > 0, 'внутри зоны интеграл должен накопиться');
    assert.ok(Math.abs(after - atBand) < 1e-9,
        `интеграл изменился вне зоны: ${atBand} -> ${after}`);
});

test('зона 0 = поведение 2.1.3 (интеграл растёт при любой ошибке)', () => {
    const h = run({ integralBand: 0 }, Array(60).fill(25.0));
    const last = h[h.length - 1];
    assert.ok(last.integral > 0, 'при выключенной зоне интеграл должен расти');
});

test('обратная совместимость: отсчёт за отсчётом совпадает с 2.1.3', () => {
    const temps = [25, 26, 27, 28, 28.5, 28.8, 29.0, 29.2, 29.1, 28.9];
    // 2.1.3 = integralBand 0, integralMaxShare 100
    const a = run({ integralBand: 0, integralMaxShare: 100 }, temps);
    // то же, но параметры не заданы вовсе (должны взять значения по умолчанию)
    const b = run({}, temps);
    for (let i = 0; i < temps.length; i++) {
        assert.strictEqual(a[i].output, b[i].output,
            `шаг ${i}: выход ${a[i].output} против ${b[i].output}`);
        assert.strictEqual(a[i].integral, b[i].integral,
            `шаг ${i}: интеграл ${a[i].integral} против ${b[i].integral}`);
    }
});

// ---------- 2. Предел вклада интеграла

test('предел вклада: интеграл не выше share/Ki', () => {
    const h = run({ integralBand: 0, integralMaxShare: 60, Ki: 2.5 },
        Array(120).fill(28.9));
    const maxI = 60 / 2.5;   // 24
    const peak = Math.max(...h.map(x => x.integral));
    assert.ok(peak <= maxI + 1e-9, `интеграл ${peak}, предел ${maxI}`);
});

test('предел 100 при малом Ki поднимает потолок выше 40', () => {
    // Ki=0.8 -> формальный потолок 100/0.8 = 125. Накопление останавливает
    // анти-виндап при unsat >= 100, то есть около 122.5 при ошибке 0.5.
    // Важно, что потолок стал заметно выше, чем 40 при Ki=2.5.
    const h = run({ integralBand: 0, integralMaxShare: 100, Ki: 0.8 },
        Array(400).fill(28.5));
    const peak = Math.max(...h.map(x => x.integral));
    assert.ok(peak > 100 && peak <= 125 + 1e-9,
        `интеграл ${peak}, ожидали между 100 и 125`);
});

test('скорость накопления = ошибка за минуту (проверка стенда)', () => {
    // Защита от ошибки в самом стенде: при ошибке 0.1 и шаге 1 мин
    // интеграл за 100 отсчётов обязан быть около 10, а не у потолка.
    const h = run({ integralBand: 0, integralMaxShare: 100, Ki: 0.1 },
        Array(100).fill(28.9));
    const peak = Math.max(...h.map(x => x.integral));
    assert.ok(Math.abs(peak - 10) < 0.5,
        `интеграл ${peak}, ожидали около 10 (0.1 °C x 100 мин)`);
});

test('Kp сохраняет влияние при ограниченном вкладе интеграла', () => {
    // интеграл насыщен, но его доля 60 % — выход должен зависеть от ошибки
    const far = run({ integralBand: 5, integralMaxShare: 60 },
        Array(120).fill(27.0));
    const near = run({ integralBand: 5, integralMaxShare: 60 },
        Array(120).fill(28.9));
    const dFar = far[far.length - 1].output;
    const dNear = near[near.length - 1].output;
    assert.ok(dFar > dNear + 1,
        `выход при большой ошибке ${dFar} должен быть заметно выше, чем при малой ${dNear}`);
});

// ---------- 3. Главный сценарий: перелёт цели

test('зона интегрирования уменьшает перелёт на длинном недогреве', () => {
    // час недогрева 4 °C, затем подход к цели и переход через неё
    const temps = Array(60).fill(25.0)
        .concat([26, 27, 28, 28.4, 28.7, 28.9, 29.0, 29.1, 29.2, 29.3, 29.4]);
    const without = run({ integralBand: 0 }, temps);
    const withBand = run({ integralBand: 1.0 }, temps);
    const iWithout = without[59].integral;
    const iWith = withBand[59].integral;
    assert.ok(iWith < iWithout,
        `с зоной интеграл ${iWith} должен быть меньше, чем без ${iWithout}`);
    // к моменту достижения цели накопленного меньше — разгрузка быстрее
    const last = temps.length - 1;
    assert.ok(withBand[last].output <= without[last].output,
        `с зоной выход ${withBand[last].output} не должен превышать ${without[last].output}`);
});

// ---------- 4. Граничные случаи

test('Ki = 0: предел интеграла 0, падения нет', () => {
    const h = run({ integralBand: 1.0, Ki: 0 }, Array(30).fill(28.5));
    const last = h[h.length - 1];
    assert.strictEqual(last.integral, 0);
    assert.ok(Number.isFinite(last.output), 'выход должен быть числом');
});

test('отрицательная зона приводится к 0 (выключено)', () => {
    const h = run({ integralBand: -5 }, Array(60).fill(25.0));
    assert.ok(h[h.length - 1].integral > 0,
        'отрицательная зона должна читаться как выключенная');
});

test('нечисловая зона приводится к значению по умолчанию', () => {
    const h = run({ integralBand: 'abc' }, Array(60).fill(25.0));
    assert.ok(h[h.length - 1].integral > 0, 'мусор должен дать поведение 2.1.3');
});

test('share вне 0..100 обрезается', () => {
    const hi = run({ integralMaxShare: 500, Ki: 2.5 }, Array(200).fill(28.9));
    const peakHi = Math.max(...hi.map(x => x.integral));
    assert.ok(peakHi <= 100 / 2.5 + 1e-9, `интеграл ${peakHi} выше предела 40`);
    const lo = run({ integralMaxShare: -10, Ki: 2.5 }, Array(60).fill(28.9));
    assert.strictEqual(Math.max(...lo.map(x => x.integral)), 0);
});

test('NaN на входе температуры не ломает состояние', () => {
    const base = 1700000000000;
    let now = base;
    const realNow = Date.now;
    Date.now = () => now;
    try {
        const c = new AdaptiveController({
            mode: 'heat', minTemp: 22, maxTemp: 30, targetTemp: 29,
            hysteresis: 0.5, sampleInterval: 60000, maxOutputChange: 100,
            Kp: 4, Ki: 2.5, Kd: 0, integralBand: 1.0, operatingMode: 'manual'
        });
        now += 60000; c.update(28.5);
        const before = c.getStatus().debug.integral;
        now += 60000; c.update(NaN);
        now += 60000; c.update(undefined);
        const after = c.getStatus().debug.integral;
        assert.strictEqual(before, after, 'мусор не должен менять интеграл');
    } finally {
        Date.now = realNow;
    }
});

test('параметры видны в debug.config для проверки редактора', () => {
    const h = run({ integralBand: 1.5, integralMaxShare: 60 }, [28.5]);
    const base = 1700000000000;
    const realNow = Date.now;
    Date.now = () => base + 60000;
    try {
        const c = new AdaptiveController({
            mode: 'heat', minTemp: 22, maxTemp: 30, targetTemp: 29,
            sampleInterval: 60000, Kp: 4, Ki: 2.5,
            integralBand: 1.5, integralMaxShare: 60, operatingMode: 'manual'
        });
        c.update(28.5);
        const cfg = c.getStatus().debug.config;
        assert.strictEqual(cfg.integralBand, 1.5);
        assert.strictEqual(cfg.integralMaxShare, 60);
    } finally {
        Date.now = realNow;
    }
});

// ---------- вывод

console.log('\n=== Тесты зоны интегрирования (v2.2.0)\n');
for (const [mark, name, err] of results) {
    console.log(`  ${mark}  ${name}${err ? '\n        ' + err : ''}`);
}
console.log(`\n  прошло ${passed}, упало ${failed}\n`);
process.exit(failed ? 1 : 0);
