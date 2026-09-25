/**
 * PID-регулятор для термостата. Выход — усилие 0..100 %.
 * direction: 'heat' | 'cool' | 'idle'.
 *
 * Персистентность:
 *  - статические параметры (min/max, гистерезис, интервал, Kp/Ki/Kd...) всегда берутся из config;
 *  - значения, заданные через msg (setpoint, mode, operatingMode, awayTemp, schedule, pid),
 *    сохраняются как overrides и восстанавливаются только если это поле не меняли в редакторе;
 *  - динамика (интеграл, выход, away/boost, метрики) восстанавливается всегда.
 */
const STATE_VERSION = 3;

function num(v, def) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : def;
}

class AdaptiveController {
    constructor(config) {
        this.config = config || {};
        this.applyConfig();

        this.currentTemp = null;
        this.targetTemp = this.config.targetTemp;
        this.manualTargetTemp = this.config.targetTemp;
        this.mode = this.config.mode || 'heat';
        this.operatingMode = this.config.operatingMode || 'manual';

        this.awayMode = false;
        this.awayTemp = num(this.config.awayTemp, 16);
        this.boostActive = false;
        this.boostEndTime = null;
        this.schedule = null;

        this.integral = 0;
        this.previousError = 0;
        this.lastUpdate = null;
        this.lastOutput = 0;
        this.direction = 'idle';
        this.lastSampleTime = 0;

        this.learningSamples = [];
        this.maxSamples = 100;
        this.parametersChanged = false;
        this.learningState = 'idle';

        this.metrics = { overshoot: 0, settlingTime: 0, errorSum: 0, samples: 0 };
        this.startTime = Date.now();

        // Что было задано через msg (переживает рестарт, если редактор не менялся)
        this.overrides = {};
    }

    /** Статические параметры — только из config */
    applyConfig() {
        const c = this.config;
        c.minTemp = num(c.minTemp, 15);
        c.maxTemp = num(c.maxTemp, 30);
        if (c.minTemp >= c.maxTemp) { c.minTemp = 15; c.maxTemp = 30; }
        c.targetTemp = Math.max(c.minTemp, Math.min(c.maxTemp, num(c.targetTemp, 21)));
        c.mode = ['heat', 'cool', 'heat_cool'].includes(c.mode) ? c.mode : 'heat';
        c.operatingMode = ['manual', 'schedule', 'off'].includes(c.operatingMode) ? c.operatingMode : 'manual';

        this.Kp = num(c.Kp, 20);
        this.Ki = num(c.Ki, 0.5);
        this.Kd = num(c.Kd, 0);
        this.hysteresis = num(c.hysteresis, 0.2);
        this.precision = num(c.precision, 0.5);
        this.sampleInterval = num(c.sampleInterval, 60000);
        this.maxOutputChange = num(c.maxOutputChange, 10);
        this.learningEnabled = c.learningEnabled === true;
    }

    // ---------- Основной цикл ----------

    update(temperature) {
        if (!Number.isFinite(temperature)) return this.getStatus();
        this.currentTemp = temperature;
        const now = Date.now();

        if (now - this.lastSampleTime < this.sampleInterval) return this.getStatus();
        this.lastSampleTime = now;

        if (this.boostActive && this.boostEndTime && now > this.boostEndTime) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.targetTemp = this.awayMode ? this.awayTemp : this.manualTargetTemp;
        }
        if (this.operatingMode === 'schedule' && this.schedule) this.syncSchedule();

        if (this.operatingMode === 'off') {
            this.lastOutput = 0;
            this.integral = 0;
            this.direction = 'idle';
            this.lastUpdate = now;
            return this.getStatus();
        }

        const { error, direction } = this.computeError(temperature);

        let dt = this.lastUpdate ? (now - this.lastUpdate) / 60000 : 0;   // минуты
        dt = Math.min(dt, 10 * this.sampleInterval / 60000);
        this.lastUpdate = now;

        let output = 0;
        if (direction !== 'idle') {
            if (direction !== this.direction) this.integral = 0;

            const P = this.Kp * error;
            const D = (dt > 0 && this.Kd > 0) ? this.Kd * (error - this.previousError) / dt : 0;

            const unsat = P + this.Ki * this.integral + D;
            const satHigh = unsat >= 100 && error > 0;
            const satLow = unsat <= 0 && error < 0;
            if (!satHigh && !satLow) this.integral += error * dt;

            const maxI = this.Ki > 0 ? 100 / this.Ki : 0;
            this.integral = Math.max(0, Math.min(maxI, this.integral));

            output = P + this.Ki * this.integral + D;
        }

        output = Math.max(0, Math.min(100, output));

        const delta = output - this.lastOutput;
        if (Math.abs(delta) > this.maxOutputChange) {
            output = this.lastOutput + Math.sign(delta) * this.maxOutputChange;
        }
        output = Math.round(output * 10) / 10;

        if (this.learningEnabled) this.learn(error, temperature, output);
        this.updateMetrics(error, direction);

        this.previousError = error;
        this.lastOutput = output;
        this.direction = direction;
        return this.getStatus();
    }

    computeError(t) {
        const diff = this.targetTemp - t;   // >0: холоднее уставки
        if (this.mode === 'heat') {
            return { error: diff, direction: diff > -this.hysteresis ? 'heat' : 'idle' };
        }
        if (this.mode === 'cool') {
            return { error: -diff, direction: -diff > -this.hysteresis ? 'cool' : 'idle' };
        }
        if (diff > this.precision) return { error: diff, direction: 'heat' };
        if (diff < -this.precision) return { error: -diff, direction: 'cool' };
        return { error: 0, direction: 'idle' };
    }

    // ---------- Статус ----------

    getStatus() {
        const err = this.currentTemp === null ? null : this.computeError(this.currentTemp);
        return {
            output: this.operatingMode === 'off' ? 0 : this.lastOutput,
            direction: this.direction,
            debug: {
                version: STATE_VERSION,
                currentTemp: this.currentTemp,
                targetTemp: this.targetTemp,
                manualTargetTemp: this.manualTargetTemp,
                error: err ? Math.round(err.error * 100) / 100 : 0,
                pid: { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd },
                Kp: this.Kp, Ki: this.Ki, Kd: this.Kd,
                integral: Math.round(this.integral * 100) / 100,
                previousError: this.previousError,
                state: this.learningState,
                operatingMode: this.operatingMode,
                mode: this.mode,
                activeMode: this.direction,
                awayMode: this.awayMode,
                awayTemp: this.awayTemp,
                boostActive: this.boostActive,
                boostRemaining: this.boostActive && this.boostEndTime
                    ? Math.max(0, Math.round((this.boostEndTime - Date.now()) / 60000)) : 0,
                trend: this.getTrend(),
                metrics: this.metrics,
                learningSamples: this.learningSamples.length,
                learningEnabled: this.learningEnabled,
                overrides: Object.keys(this.overrides),
                // Реально действующие статические параметры — для проверки редактора
                config: {
                    minTemp: this.config.minTemp,
                    maxTemp: this.config.maxTemp,
                    hysteresis: this.hysteresis,
                    precision: this.precision,
                    sampleIntervalSec: this.sampleInterval / 1000,
                    maxOutputChange: this.maxOutputChange,
                    defaultTargetTemp: this.config.targetTemp,
                    defaultMode: this.config.mode,
                    defaultOperatingMode: this.config.operatingMode
                }
            }
        };
    }

    getTrend() {
        if (this.learningSamples.length < 3) return 'stable';
        const temps = this.learningSamples.slice(-5).map(s => s.temperature);
        const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
        const last = temps[temps.length - 1];
        if (last > avg + 0.1) return 'warming';
        if (last < avg - 0.1) return 'cooling';
        return 'stable';
    }

    // ---------- Команды (через msg) ----------

    clampTemp(t) {
        return Math.max(this.config.minTemp, Math.min(this.config.maxTemp, t));
    }

    setSetpoint(t) {
        if (!Number.isFinite(t)) return;
        this.manualTargetTemp = this.clampTemp(t);
        this.overrides.targetTemp = this.manualTargetTemp;
        this.boostActive = false;
        this.boostEndTime = null;
        if (!this.awayMode) this.targetTemp = this.manualTargetTemp;
    }

    setMode(mode) {
        if (!['heat', 'cool', 'heat_cool'].includes(mode)) return;
        this.overrides.mode = mode;
        if (mode === this.mode) return;
        this.mode = mode;
        this.integral = 0;
        this.lastOutput = 0;
        this.direction = 'idle';
    }

    setOperatingMode(mode) {
        if (!['manual', 'schedule', 'off'].includes(mode)) return;
        this.overrides.operatingMode = mode;
        this.operatingMode = mode;
        if (mode === 'off') { this.lastOutput = 0; this.integral = 0; this.direction = 'idle'; }
        if (mode === 'manual') this.targetTemp = this.awayMode ? this.awayTemp : this.manualTargetTemp;
        if (mode === 'schedule' && this.schedule) this.syncSchedule();
    }

    setAwayMode(mode) {
        if (mode === false) {
            this.awayMode = false;
            this.targetTemp = this.manualTargetTemp;
            if (this.operatingMode === 'schedule') this.syncSchedule();
            return;
        }
        this.awayMode = true;
        if (typeof mode === 'number' && Number.isFinite(mode)) {
            this.awayTemp = this.clampTemp(mode);
            this.overrides.awayTemp = this.awayTemp;
        }
        this.targetTemp = this.awayTemp;
    }

    setBoost(boost) {
        if (boost === false) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.targetTemp = this.awayMode ? this.awayTemp : this.manualTargetTemp;
            return;
        }
        if (boost && typeof boost === 'object' && Number.isFinite(boost.temp)) {
            this.boostActive = true;
            this.boostEndTime = Date.now() + num(boost.duration, 60) * 60000;
            this.targetTemp = this.clampTemp(boost.temp);
        }
    }

    setSchedule(schedule, fromMsg = true) {
        this.schedule = schedule && typeof schedule === 'object' ? schedule : null;
        if (fromMsg) {
            if (this.schedule) this.overrides.schedule = this.schedule;
            else delete this.overrides.schedule;
        }
        if (this.operatingMode === 'schedule') this.syncSchedule();
    }

    /** Коэффициенты через msg. Пересчитывает интеграл под новый Ki. */
    setPID(pid) {
        if (!pid || typeof pid !== 'object') return false;
        let changed = false;
        const oldKi = this.Ki;
        ['Kp', 'Ki', 'Kd'].forEach(k => {
            const v = num(pid[k], NaN);
            if (Number.isFinite(v) && v >= 0 && v !== this[k]) { this[k] = v; changed = true; }
        });
        if (changed) {
            this.overrides.pid = { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd };
            this.integral = (this.Ki > 0 && oldKi > 0) ? this.integral * oldKi / this.Ki : 0;
        }
        return changed;
    }

    resetPID() {
        this.integral = 0;
        this.lastOutput = 0;
        this.previousError = 0;
        this.direction = 'idle';
    }

    syncSchedule() {
        if (!this.schedule || this.operatingMode !== 'schedule') return;
        if (this.boostActive || this.awayMode) return;

        const tz = (this.schedule.timezone && this.schedule.timezone !== 'local')
            ? this.schedule.timezone : undefined;
        const now = new Date();
        let day, timeStr;
        try {
            day = now.toLocaleString('en-US', { weekday: 'long', timeZone: tz }).toLowerCase();
            timeStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: tz });
        } catch (e) {
            day = now.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
            timeStr = now.toLocaleTimeString('en-US', { hour12: false });
        }

        let slots = this.schedule[day];
        if (!Array.isArray(slots)) slots = Array.isArray(this.schedule.default) ? this.schedule.default : null;
        if (!slots || slots.length === 0) {
            if (Number.isFinite(this.schedule.default)) this.targetTemp = this.clampTemp(this.schedule.default);
            return;
        }

        const valid = slots
            .filter(s => s && typeof s.time === 'string' && Number.isFinite(s.temp))
            .map(s => ({ minutes: this.timeToMinutes(s.time), temp: s.temp }))
            .filter(s => Number.isFinite(s.minutes))
            .sort((a, b) => a.minutes - b.minutes);
        if (valid.length === 0) return;

        const cur = this.timeToMinutes(timeStr);
        let target = valid[valid.length - 1].temp;
        for (let i = valid.length - 1; i >= 0; i--) {
            if (cur >= valid[i].minutes) { target = valid[i].temp; break; }
        }
        this.targetTemp = this.clampTemp(target);
    }

    timeToMinutes(time) {
        const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
    }

    // ---------- Обучение ----------

    learn(error, temperature, output) {
        this.learningSamples.push({ timestamp: Date.now(), error, temperature, output });
        if (this.learningSamples.length > this.maxSamples) this.learningSamples.shift();
        if (this.learningSamples.length < 20) { this.learningState = 'learning'; return; }

        const recent = this.learningSamples.slice(-10).map(s => Math.abs(s.error));
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (avg < 0.5) { this.learningState = 'converged'; this.adjustPIDParameters(); }
        else this.learningState = 'learning';
    }

    adjustPIDParameters() {
        const errors = this.learningSamples.map(s => s.error);
        const avgAbs = errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length;
        const maxAbs = Math.max(...errors.map(Math.abs));
        const steady = errors[errors.length - 1];
        const oldKp = this.Kp, oldKi = this.Ki, oldKd = this.Kd;

        if (avgAbs > 1.0) this.Kp = Math.min(this.Kp * 1.1, 100);
        else if (avgAbs < 0.3 && maxAbs < 0.5) this.Kp = Math.max(this.Kp * 0.95, 5);

        if (Math.abs(steady) > 0.2) this.Ki = Math.min(this.Ki * 1.1, 5);
        else if (Math.abs(steady) < 0.1) this.Ki = Math.max(this.Ki * 0.95, 0.05);

        if (maxAbs > 2.0) this.Kd = Math.min(this.Kd * 1.1 + 0.01, 5);
        else if (maxAbs < 0.5) this.Kd = Math.max(this.Kd * 0.95, 0);

        if (oldKp !== this.Kp || oldKi !== this.Ki || oldKd !== this.Kd) this.parametersChanged = true;
    }

    updateMetrics(error, direction) {
        this.metrics.samples++;
        this.metrics.errorSum += Math.abs(error);
        if (direction !== 'idle') {
            const over = Math.abs(error) - this.hysteresis;
            if (over > this.metrics.overshoot) this.metrics.overshoot = over;
        }
        if (this.metrics.settlingTime === 0 && this.metrics.samples > 10 && Math.abs(error) < 0.5) {
            this.metrics.settlingTime = Date.now() - this.startTime;
        }
    }

    hasParametersChanged() {
        const c = this.parametersChanged;
        this.parametersChanged = false;
        return c;
    }

    // ---------- Персистентность ----------

    getState() {
        return {
            version: STATE_VERSION,
            // динамика
            integral: this.integral,
            previousError: this.previousError,
            lastOutput: this.lastOutput,
            direction: this.direction,
            targetTemp: this.targetTemp,
            manualTargetTemp: this.manualTargetTemp,
            awayMode: this.awayMode,
            boostActive: this.boostActive,
            boostEndTime: this.boostEndTime,
            learningState: this.learningState,
            learningSamples: this.learningSamples,
            learnedPID: this.learningEnabled ? { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd } : null,
            metrics: this.metrics,
            // что задано через msg
            overrides: this.overrides,
            // значения редактора на момент сохранения — чтобы понять, менял ли их пользователь
            configSnapshot: {
                targetTemp: this.config.targetTemp,
                mode: this.config.mode,
                operatingMode: this.config.operatingMode,
                awayTemp: num(this.config.awayTemp, 16),
                Kp: num(this.config.Kp, 20),
                Ki: num(this.config.Ki, 0.5),
                Kd: num(this.config.Kd, 0)
            }
        };
    }

    setState(state) {
        if (!state || typeof state !== 'object') return;
        if (state.version !== STATE_VERSION) return;   // старый формат — начинаем чисто

        const snap = state.configSnapshot || {};
        const cfg = this.config;
        const ov = state.overrides || {};

        // override действует, только если поле редактора не менялось с момента сохранения
        const editorUnchanged = (key) => snap[key] !== undefined && snap[key] === cfg[key];
        const editorUnchangedNum = (key, def) => snap[key] !== undefined && snap[key] === num(cfg[key], def);

        if (ov.targetTemp !== undefined && editorUnchanged('targetTemp')) {
            this.manualTargetTemp = this.clampTemp(num(ov.targetTemp, cfg.targetTemp));
            this.overrides.targetTemp = this.manualTargetTemp;
        }
        if (ov.mode && editorUnchanged('mode') && ['heat', 'cool', 'heat_cool'].includes(ov.mode)) {
            this.mode = ov.mode;
            this.overrides.mode = ov.mode;
        }
        if (ov.operatingMode && editorUnchanged('operatingMode') && ['manual', 'schedule', 'off'].includes(ov.operatingMode)) {
            this.operatingMode = ov.operatingMode;
            this.overrides.operatingMode = ov.operatingMode;
        }
        if (ov.awayTemp !== undefined && editorUnchangedNum('awayTemp', 16)) {
            this.awayTemp = this.clampTemp(num(ov.awayTemp, this.awayTemp));
            this.overrides.awayTemp = this.awayTemp;
        }
        if (ov.schedule && typeof ov.schedule === 'object') {
            this.schedule = ov.schedule;
            this.overrides.schedule = ov.schedule;
        }

        // Коэффициенты
        const pidEditorUnchanged = editorUnchangedNum('Kp', 20) && editorUnchangedNum('Ki', 0.5) && editorUnchangedNum('Kd', 0);
        let restoredPID = null;
        if (pidEditorUnchanged) {
            if (ov.pid) restoredPID = ov.pid;
            else if (this.learningEnabled && state.learnedPID) restoredPID = state.learnedPID;
        }
        if (restoredPID) {
            this.Kp = num(restoredPID.Kp, this.Kp);
            this.Ki = num(restoredPID.Ki, this.Ki);
            this.Kd = num(restoredPID.Kd, this.Kd);
            if (ov.pid) this.overrides.pid = { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd };
        }

        // Динамика
        this.awayMode = state.awayMode === true;
        this.boostActive = state.boostActive === true && state.boostEndTime > Date.now();
        this.boostEndTime = this.boostActive ? state.boostEndTime : null;

        if (this.boostActive) this.targetTemp = this.clampTemp(num(state.targetTemp, this.manualTargetTemp));
        else if (this.awayMode) this.targetTemp = this.awayTemp;
        else this.targetTemp = this.manualTargetTemp;

        this.previousError = num(state.previousError, 0);
        this.lastOutput = Math.max(0, Math.min(100, num(state.lastOutput, 0)));
        this.direction = state.direction || 'idle';
        this.learningState = state.learningState || 'idle';
        this.learningSamples = Array.isArray(state.learningSamples) ? state.learningSamples : [];
        this.metrics = state.metrics || this.metrics;

        // Интеграл: масштабируем, если Ki изменился
        const savedKi = restoredPID ? num(restoredPID.Ki, this.Ki)
            : (state.learnedPID ? num(state.learnedPID.Ki, snap.Ki) : num(snap.Ki, this.Ki));
        let integral = num(state.integral, 0);
        if (this.Ki > 0 && savedKi > 0 && savedKi !== this.Ki) integral = integral * savedKi / this.Ki;
        const maxI = this.Ki > 0 ? 100 / this.Ki : 0;
        this.integral = Math.max(0, Math.min(maxI, integral));

        if (this.operatingMode === 'schedule' && this.schedule) this.syncSchedule();
    }
}

module.exports = AdaptiveController;
