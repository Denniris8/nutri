import { describe, expect, it } from 'vitest';
import { GarminClient } from './garmin.client';

describe('GarminClient daily health snapshot concurrency', () => {
  it('limits in-flight endpoints while returning every snapshot family', async () => {
    const client = new GarminClient('test@example.invalid', 'unused');
    const methods = [
      'getDailySummary', 'getHeartRate', 'getStress', 'getBodyBattery', 'getSleepData',
      'getHRV', 'getRespiration', 'getSpO2', 'getStepsChart', 'getFloors', 'getIntensityMinutes',
    ];
    let active = 0;
    let peak = 0;
    for (const method of methods) {
      client[method] = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return method;
      };
    }

    const snapshot = await client.getDailyHealthSnapshot('2026-09-25');

    expect(peak).toBeLessThanOrEqual(4);
    expect(snapshot.date).toBe('2026-09-25');
    expect(Object.keys(snapshot)).toHaveLength(12);
    for (const key of [
      'summary', 'heartRate', 'stress', 'bodyBattery', 'sleep', 'hrv',
      'respiration', 'spo2', 'steps', 'floors', 'intensityMinutes',
    ]) expect(snapshot[key]).toBeDefined();
  });
});
