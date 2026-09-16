/**
 * PID-регулятор для термостата. Выход — усилие 0..100 %.
 * direction: 'heat' | 'cool' | 'idle' — что именно делаем.
 */
class AdaptiveController {
    constructor(config) {
        this.config = config;
        this.currentTemp = null;
        this.targetTemp = config.targetTemp;
        this.manualTargetTemp = config.targetTemp;   // к чему возвращаться после boost/away
        this.mode = config.mode || 'heat';
        this.operatingMode = config.operatingMode || 'manual';

        this.awayMode = false;
        this.awayTemp = num(config.awayTemp, 16);
        this.boostActive = false;
        this.boostEndTime = null;
        this.schedule = null;

        // PID (единицы: %, °C, минуты)
        this.Kp = num(config.Kp, 20);     // 20 %/°C → 5 °C ошибки = 100 %
        this.Ki = num(config.Ki, 0.5);    // %/(°C·мин)
        this.Kd = num(config.Kd, 0);
        this.integral = 0;                // °C·мин
        this.previousError = 0;
        this.lastUpdate = null;

        this.lastOutput = 0;              // 0..100
        this.direction = 'idle';
        this.maxOutputChange = num(config.maxOutputChange, 10); // %/цикл
        this.hysteresis = num(config.hysteresis, 0.2);
        this.precision = num(config.precision, 0.5);
        this.sampleInterval = num(config.sampleInterval, 60000);
        this.lastSampleTime = 0;          // первое измерение обрабатывается сразу

        // Обучение
        this.learningEnabled = config.learningEnabled === true;
        this.learningSamples = [];
        this.maxSamples = 100;
        this.parametersChanged = false;
        this.learningState = 'idle';

        this.metrics = { overshoot: 0, settlingTime: 0, errorSum: 0, samples: 0 };
        this.startTime = Date.now();
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
            this.targetTemp = this.manualTargetTemp;
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

        // dt в минутах; после долгого простоя/рестарта не даём интегралу прыгнуть
        let dt = this.lastUpdate ? (now - this.lastUpdate) / 60000 : 0;
        dt = Math.min(dt, 10 * this.sampleInterval / 60000);
        this.lastUpdate = now;

        let output = 0;
        if (direction === 'idle') {
            // Нет запроса на воздействие: выход 0, интеграл не растёт
            output = 0;
        } else {
            if (direction !== this.direction) this.integral = 0; // смена heat<->cool

            const P = this.Kp * error;
            const D = (dt > 0 && this.Kd > 0) ? this.Kd * (error - this.previousError) / dt : 0;

            // Anti-windup: не интегрируем, если уже упёрлись в предел в ту же сторону
            const unsat = P + this.Ki * this.integral + D;
            const saturatedHigh = unsat >= 100 && error > 0;
            const saturatedLow  = unsat <= 0   && error < 0;
            if (!saturatedHigh && !saturatedLow) this.integral += error * dt;

            const maxI = this.Ki > 0 ? 100 / this.Ki : 0;   // Ki*I не больше 100 %
            this.integral = Math.max(0, Math.min(maxI, this.integral));

            output = P + this.Ki * this.integral + D;
        }

        output = Math.max(0, Math.min(100, output));

        // Ограничение скорости изменения
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

    /**
     * error > 0 — нужно воздействие в направлении direction.
     * Направление держится, пока не перескочили уставку больше чем на hysteresis.
     */
    computeError(t) {
        const diff = this.targetTemp - t;      // >0: холоднее уставки
        if (this.mode === 'heat') {
            return diff > -this.hysteresis
                ? { error: diff, direction: 'heat' }
                : { error: diff, direction: 'idle' };
        }
        if (this.mode === 'cool') {
            return -diff > -this.hysteresis
                ? { error: -diff, direction: 'cool' }
                : { error: -diff, direction: 'idle' };
        }
        // heat_cool: мёртвая зона ±precision вокруг уставки
        if (diff > this.precision)  return { error: diff,  direction: 'heat' };
        if (diff < -this.precision) return { error: -diff, direction: 'cool' };
        return { error: 0, direction: 'idle' };
    }

    // ---------- Статус ----------

    getStatus() {
        const err = this.currentTemp === null ? 0 : this.computeError(this.currentTemp);
        return {
            output: this.operatingMode === 'off' ? 0 : this.lastOutput,
            direction: this.direction,
            debug: {
                currentTemp: this.currentTemp,
                targetTemp: this.targetTemp,
                error: err ? err.error : 0,
                pid: { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd },
                Kp: this.Kp, Ki: this.Ki, Kd: this.Kd,
                integral: Math.round(this.integral * 100) / 100,
                previousError: this.previousError,
                state: this.learningState,
                operatingMode: this.operatingMode,
                mode: this.mode,
                activeMode: this.direction,
                awayMode: this.awayMode,
                boostActive: this.boostActive,
                boostRemaining: this.boostActive && this.boostEndTime
                    ? Math.max(0, Math.round((this.boostEndTime - Date.now()) / 60000)) : 0,
                trend: this.getTrend(),
                metrics: this.metrics,
                learningSamples: this.learningSamples.length
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

    // ---------- Команды ----------

    clampTemp(t) {
        return Math.max(this.config.minTemp, Math.min(this.config.maxTemp, t));
    }

    setSetpoint(t) {
        if (!Number.isFinite(t)) return;
        this.manualTargetTemp = this.clampTemp(t);
        this.boostActive = false;
        this.boostEndTime = null;
        if (!this.awayMode) this.targetTemp = this.manualTargetTemp;
    }

    setMode(mode) {
        if (!['heat', 'cool', 'heat_cool'].includes(mode) || mode === this.mode) return;
        this.mode = mode;
        this.integral = 0;
        this.lastOutput = 0;
        this.direction = 'idle';
    }

    setOperatingMode(mode) {
        if (!['manual', 'schedule', 'off'].includes(mode)) return;
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
        if (typeof mode === 'number' && Number.isFinite(mode)) this.awayTemp = this.clampTemp(mode);
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
            this.boostEndTime = Date.now() + (num(boost.duration, 60)) * 60000;
            this.targetTemp = this.clampTemp(boost.temp);
        }
    }

    setSchedule(schedule) {
        this.schedule = schedule && typeof schedule === 'object' ? schedule : null;
        if (this.operatingMode === 'schedule') this.syncSchedule();
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
            // default может быть просто числом
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
        let target = valid[valid.length - 1].temp;   // до первого слота действует последний (со вчера)
        for (let i = valid.length - 1; i >= 0; i--) {
            if (cur >= valid[i].minutes) { target = valid[i].temp; break; }
        }
        this.targetTemp = this.clampTemp(target);
    }

    timeToMinutes(time) {
        const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
    }

    // ---------- Обучение (упрощённое, единицы — проценты) ----------

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
            version: 2,
            Kp: this.Kp, Ki: this.Ki, Kd: this.Kd,
            integral: this.integral,
            previousError: this.previousError,
            lastOutput: this.lastOutput,
            direction: this.direction,
            targetTemp: this.targetTemp,
            manualTargetTemp: this.manualTargetTemp,
            mode: this.mode,
            operatingMode: this.operatingMode,
            awayMode: this.awayMode,
            awayTemp: this.awayTemp,
            boostActive: this.boostActive,
            boostEndTime: this.boostEndTime,
            learningState: this.learningState,
            learningSamples: this.learningSamples,
            metrics: this.metrics,
            // снимок конфига, при котором сохранялись — чтобы понять, менял ли пользователь редактор
            configSnapshot: {
                targetTemp: this.config.targetTemp,
                mode: this.config.mode,
                operatingMode: this.config.operatingMode
            }
        };
    }

    setState(state) {
        if (!state || typeof state !== 'object') return;
        // Старый формат (Kp≈1, выход в °C) несовместим — берём только уставку/режимы
        const compatible = state.version === 2;
        const snap = state.configSnapshot || {};
        const cfg = this.config;

        // Если значение в редакторе изменили после сохранения — приоритет у редактора
        const pick = (key, saved, fallback) =>
            (snap[key] !== undefined && snap[key] !== cfg[key]) ? cfg[key] : (saved ?? fallback);

        this.manualTargetTemp = this.clampTemp(num(pick('targetTemp', state.manualTargetTemp ?? state.targetTemp, cfg.targetTemp), cfg.targetTemp));
        this.mode = pick('mode', state.mode, cfg.mode);
        this.operatingMode = pick('operatingMode', state.operatingMode, cfg.operatingMode || 'manual');

        this.awayMode = state.awayMode === true;
        this.awayTemp = num(state.awayTemp, cfg.awayTemp);
        this.boostActive = state.boostActive === true && state.boostEndTime > Date.now();
        this.boostEndTime = this.boostActive ? state.boostEndTime : null;
        this.targetTemp = this.clampTemp(num(state.targetTemp, this.manualTargetTemp));
        if (this.awayMode) this.targetTemp = this.awayTemp;

        if (compatible) {
            this.Kp = num(state.Kp, this.Kp);
            this.Ki = num(state.Ki, this.Ki);
            this.Kd = num(state.Kd, this.Kd);
            this.integral = num(state.integral, 0);
            this.previousError = num(state.previousError, 0);
            this.lastOutput = Math.max(0, Math.min(100, num(state.lastOutput, 0)));
            this.direction = state.direction || 'idle';
            this.learningState = state.learningState || 'idle';
            this.learningSamples = Array.isArray(state.learningSamples) ? state.learningSamples : [];
            this.metrics = state.metrics || this.metrics;
        }
    }
}

function num(v, def) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : def;
}

module.exports = AdaptiveController;
