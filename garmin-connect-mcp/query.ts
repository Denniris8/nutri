#!/usr/bin/env node
import { GarminClient } from './src/client/garmin.client.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const email = process.env.GARMIN_EMAIL;
const password = process.env.GARMIN_PASSWORD;

if (!email || !password) {
  console.error('Error: GARMIN_EMAIL y GARMIN_PASSWORD deben estar en .env');
  process.exit(1);
}

const client = new GarminClient(email, password);

const QUERIES = {
  'activities': {
    desc: 'Últimas 10 actividades',
    fn: async () => {
      const acts = await client.getActivities(0, 10);
      return acts.map((a: any) => ({
        fecha: a.startTimeLocal?.split(' ')[0],
        tipo: a.activityType?.typeKey,
        duracion_min: Math.round(a.duration / 60),
        distancia_km: a.distance ? (a.distance / 1000).toFixed(1) : '-',
        calorias: a.calories,
        hr_prom: a.averageHR
      }));
    }
  },
  'today': {
    desc: 'Resumen del día de hoy',
    fn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const summary = await client.getDailySummary(today);
      return {
        fecha: today,
        pasos: summary.totalSteps,
        calorias: summary.totalKilocalories,
        hr_reposo: summary.restingHeartRate,
        estres: summary.averageStressLevel,
        intensidad_mod: summary.moderateIntensityMinutes,
        intensidad_vig: summary.vigorousIntensityMinutes
      };
    }
  },
  'week': {
    desc: 'Resumen de la semana (últimos 7 días)',
    fn: async () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 6);
      
      const formatDate = (d: Date) => d.toISOString().split('T')[0];
      const results = [];
      
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(d);
        try {
          const summary = await client.getDailySummary(dateStr);
          results.push({
            fecha: dateStr,
            pasos: summary.totalSteps,
            kcal: summary.totalKilocalories,
            hr_reposo: summary.restingHeartRate
          });
        } catch (e) {
          results.push({ fecha: dateStr, error: 'No disponible' });
        }
      }
      return results;
    }
  },
  'week_range_calories': {
    desc: 'Calorías semanales (lunes a hoy/domingo): activas y gasto total',
    fn: async () => {
      const formatDate = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      const today = new Date();
      const monday = new Date(today);
      const diffToMonday = (today.getDay() + 6) % 7;
      monday.setDate(today.getDate() - diffToMonday);

      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);

      const end = today < sunday ? today : sunday;

      const startStr = formatDate(monday);
      const endStr = formatDate(end);

      const porDia = [] as any[];
      let totalActivas = 0;
      let totalGasto = 0;

      for (let d = new Date(monday); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const summary = await client.getDailySummary(dateStr);
          const activas = Number(summary.activeKilocalories || 0);
          const gastoTotal = Number(summary.totalKilocalories || 0);
          totalActivas += activas;
          totalGasto += gastoTotal;
          porDia.push({
            fecha: dateStr,
            kcal_activas: activas,
            kcal_gasto_total: gastoTotal,
          });
        } catch (e) {
          porDia.push({
            fecha: dateStr,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return {
        periodo: {
          inicio: startStr,
          fin: endStr,
          criterio: 'semana calendario local (lunes a domingo; si no llega a domingo, corta en hoy)',
        },
        totales: {
          kcal_activas: totalActivas,
          kcal_gasto_total: totalGasto,
        },
        por_dia: porDia,
      };
    }
  },
  'sleep': {
    desc: 'Últimos 7 días de sueño',
    fn: async () => {
      const end = new Date().toISOString().split('T')[0];
      const start = new Date();
      start.setDate(start.getDate() - 6);
      const startStr = start.toISOString().split('T')[0];
      
      const sleepData = await client.getSleepData(startStr, end);
      return sleepData.map((s: any) => ({
        fecha: s.calendarDate,
        total_h: (s.sleepTimeSeconds / 3600).toFixed(1),
        deep_h: (s.deepSleepSeconds / 3600).toFixed(1),
        light_h: (s.lightSleepSeconds / 3600).toFixed(1),
        rem_h: (s.remSleepSeconds / 3600).toFixed(1),
        score: s.overallSleepScore?.value || '-'
      }));
    }
  },
  'weight': {
    desc: 'Últimos registros de peso',
    fn: async () => {
      const end = new Date().toISOString().split('T')[0];
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const startStr = start.toISOString().split('T')[0];
      
      const data = await client.getBodyComposition(startStr, end);
      return data.map((d: any) => ({
        fecha: d.dateWeighed || d.calendarDate,
        peso_kg: d.weight,
        bmi: d.bmi,
        grasa_pct: d.bodyFatPercentage,
        musculo_pct: d.muscleMass
      }));
    }
  },
  'stats': {
    desc: 'Estadísticas generales (últimos 7 días)',
    fn: async () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 6);
      const formatDate = (d: Date) => d.toISOString().split('T')[0];
      
      const summaries = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        try {
          const summary = await client.getDailySummary(formatDate(d));
          summaries.push(summary);
        } catch (e) {}
      }
      
      const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      
      return {
        dias_analizados: summaries.length,
        pasos_promedio: Math.round(avg(summaries.map(s => s.totalSteps || 0))),
        calorias_promedio: Math.round(avg(summaries.map(s => s.totalKilocalories || 0))),
        hr_reposo_promedio: Math.round(avg(summaries.filter(s => s.restingHeartRate).map(s => s.restingHeartRate))),
        estres_promedio: Math.round(avg(summaries.filter(s => s.averageStressLevel).map(s => s.averageStressLevel)))
      };
    }
  },
  'gym': {
    desc: 'Últimas sesiones de gimnasio (últimos 30 días)',
    fn: async () => {
      const end = new Date().toISOString().split('T')[0];
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const startStr = start.toISOString().split('T')[0];
      
      const activities = await client.getActivitiesByDate(startStr, end);
      const gym = activities.filter((a: any) => a.activityType?.typeKey === 'strength_training');
      
      return gym.map((a: any) => ({
        fecha: a.startTimeLocal?.split(' ')[0],
        duracion_min: Math.round(a.duration / 60),
        calorias: a.calories,
        hr_promedio: a.averageHR,
        hr_maxima: a.maxHR,
        series: a.activeSets || '-'
      }));
    }
  },
  'full': {
    desc: 'TODOS los datos de la última semana (sin filtrar, completo)',
    fn: async () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 6);
      
      const formatDate = (d: Date) => d.toISOString().split('T')[0];
      const startStr = formatDate(start);
      const endStr = formatDate(end);
      
      console.error('📊 Recopilando datos completos de la última semana...');
      const data: any = {
        periodo: {
          inicio: startStr,
          fin: endStr,
          dias: 7
        },
        metadata: {
          fecha_consulta: new Date().toISOString(),
          zona_horaria: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      };
      
      // 1. ACTIVIDADES (completas, sin filtrar)
      console.error('  → Actividades...');
      try {
        data.actividades = await client.getActivitiesByDate(startStr, endStr);
        console.error(`     ✓ ${data.actividades.length} actividades`);
      } catch (e) {
        data.actividades = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 2. RESÚMENES DIARIOS (completos)
      console.error('  → Resúmenes diarios...');
      data.resumenes_diarios = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const summary = await client.getDailySummary(dateStr);
          data.resumenes_diarios.push({ fecha: dateStr, datos: summary });
        } catch (e) {
          data.resumenes_diarios.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.resumenes_diarios.length} días`);
      
      // 3. DATOS DE SUEÑO (completos)
      console.error('  → Datos de sueño...');
      try {
        data.sueno = await client.getSleepData(startStr, endStr);
        console.error(`     ✓ ${data.sueno.length} registros`);
      } catch (e) {
        data.sueno = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 4. FRECUENCIA CARDÍACA (por día, completo)
      console.error('  → Frecuencia cardíaca...');
      data.frecuencia_cardiaca = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const hr = await client.getHeartRate(dateStr);
          data.frecuencia_cardiaca.push({ fecha: dateStr, datos: hr });
        } catch (e) {
          data.frecuencia_cardiaca.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.frecuencia_cardiaca.length} días`);
      
      // 5. ESTRÉS (por día, completo)
      console.error('  → Niveles de estrés...');
      data.estres = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const stress = await client.getStress(dateStr);
          data.estres.push({ fecha: dateStr, datos: stress });
        } catch (e) {
          data.estres.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.estres.length} días`);
      
      // 6. BODY BATTERY
      console.error('  → Body Battery...');
      try {
        data.body_battery = await client.getBodyBattery(startStr, endStr);
        console.error(`     ✓ Datos obtenidos`);
      } catch (e) {
        data.body_battery = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 7. COMPOSICIÓN CORPORAL
      console.error('  → Composición corporal...');
      try {
        data.composicion_corporal = await client.getBodyComposition(startStr, endStr);
        console.error(`     ✓ ${data.composicion_corporal?.length || 0} registros`);
      } catch (e) {
        data.composicion_corporal = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 8. RESPIRACIÓN
      console.error('  → Respiración...');
      data.respiracion = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const resp = await client.getRespiration(dateStr);
          data.respiracion.push({ fecha: dateStr, datos: resp });
        } catch (e) {
          data.respiracion.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.respiracion.length} días`);
      
      // 9. SPO2 (Oxígeno en sangre)
      console.error('  → SpO2...');
      data.spo2 = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const spo2 = await client.getSpO2(dateStr);
          data.spo2.push({ fecha: dateStr, datos: spo2 });
        } catch (e) {
          data.spo2.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.spo2.length} días`);
      
      // 10. PASOS (gráfica detallada por día)
      console.error('  → Pasos detallados...');
      data.pasos_detalle = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const steps = await client.getStepsChart(dateStr);
          data.pasos_detalle.push({ fecha: dateStr, datos: steps });
        } catch (e) {
          data.pasos_detalle.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.pasos_detalle.length} días`);
      
      // 11. MINUTOS DE INTENSIDAD
      console.error('  → Minutos de intensidad...');
      data.intensidad_minutos = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const intensity = await client.getIntensityMinutes(dateStr);
          data.intensidad_minutos.push({ fecha: dateStr, datos: intensity });
        } catch (e) {
          data.intensidad_minutos.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.intensidad_minutos.length} días`);
      
      // 12. PISOS SUBIDOS
      console.error('  → Pisos subidos...');
      data.pisos = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const floors = await client.getFloors(dateStr);
          data.pisos.push({ fecha: dateStr, datos: floors });
        } catch (e) {
          data.pisos.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.pisos.length} días`);
      
      // 13. HIDRATACIÓN
      console.error('  → Hidratación...');
      data.hidratacion = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const hydration = await client.getHydration(dateStr);
          data.hidratacion.push({ fecha: dateStr, datos: hydration });
        } catch (e) {
          data.hidratacion.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.hidratacion.length} días`);
      
      // 14. HRV (Variabilidad de Frecuencia Cardíaca)
      console.error('  → HRV...');
      try {
        data.hrv = await client.getHRV(startStr, endStr);
        console.error(`     ✓ Datos obtenidos`);
      } catch (e) {
        data.hrv = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 15. DATOS DE RENDIMIENTO
      console.error('  → Datos de rendimiento...');
      data.rendimiento = {};
      
      try {
        data.rendimiento.vo2max = await client.getVO2Max();
        console.error(`     ✓ VO2 Max`);
      } catch (e) {
        data.rendimiento.vo2max = { error: e instanceof Error ? e.message : String(e) };
      }
      
      try {
        data.rendimiento.training_status = await client.getTrainingStatus();
        console.error(`     ✓ Training Status`);
      } catch (e) {
        data.rendimiento.training_status = { error: e instanceof Error ? e.message : String(e) };
      }
      
      try {
        data.rendimiento.training_readiness = await client.getTrainingReadiness();
        console.error(`     ✓ Training Readiness`);
      } catch (e) {
        data.rendimiento.training_readiness = { error: e instanceof Error ? e.message : String(e) };
      }
      
      try {
        data.rendimiento.fitness_age = await client.getFitnessAge();
        console.error(`     ✓ Fitness Age`);
      } catch (e) {
        data.rendimiento.fitness_age = { error: e instanceof Error ? e.message : String(e) };
      }
      
      console.error('\n✅ Recopilación completa!\n');
      
      return data;
    }
  },
  'month': {
    desc: 'TODOS los datos del último mes (30 días, sin filtrar, completo)',
    fn: async () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 29);
      
      const formatDate = (d: Date) => d.toISOString().split('T')[0];
      const startStr = formatDate(start);
      const endStr = formatDate(end);
      
      console.error('📊 Recopilando datos completos del último mes (30 días)...');
      const data: any = {
        periodo: {
          inicio: startStr,
          fin: endStr,
          dias: 30
        },
        metadata: {
          fecha_consulta: new Date().toISOString(),
          zona_horaria: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      };
      
      // 1. ACTIVIDADES (completas, sin filtrar)
      console.error('  → Actividades...');
      try {
        data.actividades = await client.getActivitiesByDate(startStr, endStr);
        console.error(`     ✓ ${data.actividades.length} actividades`);
      } catch (e) {
        data.actividades = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 2. RESÚMENES DIARIOS (completos)
      console.error('  → Resúmenes diarios...');
      data.resumenes_diarios = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const summary = await client.getDailySummary(dateStr);
          data.resumenes_diarios.push({ fecha: dateStr, datos: summary });
        } catch (e) {
          data.resumenes_diarios.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.resumenes_diarios.length} días`);
      
      // 3. DATOS DE SUEÑO (completos)
      console.error('  → Datos de sueño...');
      try {
        data.sueno = await client.getSleepData(startStr, endStr);
        console.error(`     ✓ ${data.sueno.length} registros`);
      } catch (e) {
        data.sueno = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 4. FRECUENCIA CARDÍACA (por día, completo)
      console.error('  → Frecuencia cardíaca...');
      data.frecuencia_cardiaca = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const hr = await client.getHeartRate(dateStr);
          data.frecuencia_cardiaca.push({ fecha: dateStr, datos: hr });
        } catch (e) {
          data.frecuencia_cardiaca.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.frecuencia_cardiaca.length} días`);
      
      // 5. ESTRÉS (por día, completo)
      console.error('  → Niveles de estrés...');
      data.estres = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const stress = await client.getStress(dateStr);
          data.estres.push({ fecha: dateStr, datos: stress });
        } catch (e) {
          data.estres.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.estres.length} días`);
      
      // 6. BODY BATTERY
      console.error('  → Body Battery...');
      try {
        data.body_battery = await client.getBodyBattery(startStr, endStr);
        console.error(`     ✓ Datos obtenidos`);
      } catch (e) {
        data.body_battery = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 7. COMPOSICIÓN CORPORAL
      console.error('  → Composición corporal...');
      try {
        data.composicion_corporal = await client.getBodyComposition(startStr, endStr);
        console.error(`     ✓ ${data.composicion_corporal?.length || 0} registros`);
      } catch (e) {
        data.composicion_corporal = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 8. RESPIRACIÓN
      console.error('  → Respiración...');
      data.respiracion = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const resp = await client.getRespiration(dateStr);
          data.respiracion.push({ fecha: dateStr, datos: resp });
        } catch (e) {
          data.respiracion.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.respiracion.length} días`);
      
      // 9. SPO2 (Oxígeno en sangre)
      console.error('  → SpO2...');
      data.spo2 = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const spo2 = await client.getSpO2(dateStr);
          data.spo2.push({ fecha: dateStr, datos: spo2 });
        } catch (e) {
          data.spo2.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.spo2.length} días`);
      
      // 10. PASOS (gráfica detallada por día)
      console.error('  → Pasos detallados...');
      data.pasos_detalle = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const steps = await client.getStepsChart(dateStr);
          data.pasos_detalle.push({ fecha: dateStr, datos: steps });
        } catch (e) {
          data.pasos_detalle.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.pasos_detalle.length} días`);
      
      // 11. MINUTOS DE INTENSIDAD
      console.error('  → Minutos de intensidad...');
      data.intensidad_minutos = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const intensity = await client.getIntensityMinutes(dateStr);
          data.intensidad_minutos.push({ fecha: dateStr, datos: intensity });
        } catch (e) {
          data.intensidad_minutos.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.intensidad_minutos.length} días`);
      
      // 12. PISOS SUBIDOS
      console.error('  → Pisos subidos...');
      data.pisos = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const floors = await client.getFloors(dateStr);
          data.pisos.push({ fecha: dateStr, datos: floors });
        } catch (e) {
          data.pisos.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.pisos.length} días`);
      
      // 13. HIDRATACIÓN
      console.error('  → Hidratación...');
      data.hidratacion = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(new Date(d));
        try {
          const hydration = await client.getHydration(dateStr);
          data.hidratacion.push({ fecha: dateStr, datos: hydration });
        } catch (e) {
          data.hidratacion.push({ 
            fecha: dateStr, 
            error: e instanceof Error ? e.message : String(e) 
          });
        }
      }
      console.error(`     ✓ ${data.hidratacion.length} días`);
      
      // 14. HRV (Variabilidad de Frecuencia Cardíaca)
      console.error('  → HRV...');
      try {
        data.hrv = await client.getHRV(startStr, endStr);
        console.error(`     ✓ Datos obtenidos`);
      } catch (e) {
        data.hrv = { error: e instanceof Error ? e.message : String(e) };
      }
      
      // 15. DATOS DE RENDIMIENTO
      console.error('  → Datos de rendimiento...');
      data.rendimiento = {};
      
      try {
        data.rendimiento.vo2max = await client.getVO2Max();
        console.error(`     ✓ VO2 Max`);
      } catch (e) {
        data.rendimiento.vo2max = { error: e instanceof Error ? e.message : String(e) };
      }
      
      try {
        data.rendimiento.training_status = await client.getTrainingStatus();
        console.error(`     ✓ Training Status`);
      } catch (e) {
        data.rendimiento.training_status = { error: e instanceof Error ? e.message : String(e) };
      }
      
      try {
        data.rendimiento.training_readiness = await client.getTrainingReadiness();
        console.error(`     ✓ Training Readiness`);
      } catch (e) {
        data.rendimiento.training_readiness = { error: e instanceof Error ? e.message : String(e) };
      }
      
      try {
        data.rendimiento.fitness_age = await client.getFitnessAge();
        console.error(`     ✓ Fitness Age`);
      } catch (e) {
        data.rendimiento.fitness_age = { error: e instanceof Error ? e.message : String(e) };
      }
      
      console.error('\n✅ Recopilación mensual completa!\n');
      
      return data;
    }
  }
};

async function main() {
  const command = process.argv[2];
  
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log('\n🏃 GARMIN QUERY CLI - Consultas rápidas de datos Garmin\n');
    console.log('Uso: npm run query <comando>\n');
    console.log('Comandos disponibles:\n');
    Object.entries(QUERIES).forEach(([key, { desc }]) => {
      console.log(`  ${key.padEnd(12)} - ${desc}`);
    });
    console.log('\nEjemplo: npm run query today');
    console.log('         npm run query activities\n');
    return;
  }
  
  const query = QUERIES[command as keyof typeof QUERIES];
  
  if (!query) {
    console.error(`\n❌ Comando no reconocido: ${command}`);
    console.error('Usa "npm run query help" para ver comandos disponibles\n');
    process.exit(1);
  }
  
  try {
    console.error(`\n⏳ Consultando: ${query.desc}...\n`);
    const result = await query.fn();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
