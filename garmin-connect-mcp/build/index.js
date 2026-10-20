#!/usr/bin/env node
import {
  DEFAULT_ACTIVITIES_LIMIT,
  GarminClient
} from "./chunk-MUWXEBHR.js";

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/dtos/date-params.dto.ts
import { z as z2 } from "zod";

// src/constants/validations.ts
import { z } from "zod";
var dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format");

// src/dtos/date-params.dto.ts
var dateParamSchema = z2.object({
  date: dateString.optional().describe("Date in YYYY-MM-DD format. Defaults to today if not provided")
});
var dateRangeParamSchema = z2.object({
  startDate: dateString.describe("Start date in YYYY-MM-DD format"),
  endDate: dateString.describe("End date in YYYY-MM-DD format")
});
var weeklyParamSchema = z2.object({
  endDate: dateString.describe("End date in YYYY-MM-DD format"),
  weeks: z2.number().min(1).max(52).default(52).optional().describe("Number of weeks to look back (1-52). Defaults to 52 (full year)")
});
var dateRangeOptionalEndSchema = z2.object({
  startDate: dateString.describe("Start date in YYYY-MM-DD format"),
  endDate: dateString.optional().describe("End date in YYYY-MM-DD format. Defaults to startDate if not provided")
});

// src/dtos/activities.dto.ts
import { z as z3 } from "zod";
var getActivitiesSchema = z3.object({
  start: z3.number().min(0).default(0).optional().describe("Pagination offset. Defaults to 0"),
  limit: z3.number().min(1).max(100).default(20).optional().describe("Number of activities to return (1-100). Defaults to 20"),
  activityType: z3.string().optional().describe("Filter by activity type (e.g. running, cycling, swimming)")
});
var getActivitiesByDateSchema = z3.object({
  startDate: dateString.describe("Start date in YYYY-MM-DD format"),
  endDate: dateString.describe("End date in YYYY-MM-DD format"),
  activityType: z3.string().optional().describe("Filter by activity type (e.g. running, cycling, swimming)")
});
var getActivitySchema = z3.object({
  activityId: z3.number().positive().describe("The Garmin activity ID")
});
var getProgressSummarySchema = z3.object({
  startDate: dateString.describe("Start date in YYYY-MM-DD format"),
  endDate: dateString.describe("End date in YYYY-MM-DD format"),
  metric: z3.string().default("distance").optional().describe("Metric to aggregate: distance, duration, calories. Defaults to distance")
});

// src/dtos/devices.dto.ts
import { z as z4 } from "zod";
var getDeviceSettingsSchema = z4.object({
  deviceId: z4.string().describe("The Garmin device ID")
});
var getDeviceSolarSchema = z4.object({
  deviceId: z4.string().describe("The Garmin device ID"),
  startDate: dateString.describe("Start date in YYYY-MM-DD format"),
  endDate: dateString.describe("End date in YYYY-MM-DD format")
});
var getGearStatsSchema = z4.object({
  gearUuid: z4.string().uuid().describe("The UUID of the gear item")
});
var getWorkoutSchema = z4.object({
  workoutId: z4.string().describe("The workout ID")
});
var getGearActivitiesSchema = z4.object({
  gearUuid: z4.string().uuid().describe("The UUID of the gear item"),
  start: z4.number().min(0).default(0).optional().describe("Pagination offset. Defaults to 0"),
  limit: z4.number().min(1).max(100).default(20).optional().describe("Number of activities to return (1-100). Defaults to 20")
});

// src/dtos/performance.dto.ts
import { z as z5 } from "zod";
var getRacePredictionsSchema = z5.object({
  startDate: dateString.optional().describe("Start date in YYYY-MM-DD format. Omit for latest prediction only"),
  endDate: dateString.optional().describe("End date in YYYY-MM-DD format. Required if startDate is provided"),
  type: z5.enum(["daily", "monthly"]).default("daily").optional().describe("Aggregation type: daily or monthly. Defaults to daily")
});
var getLactateThresholdSchema = z5.object({
  startDate: dateString.optional().describe("Start date in YYYY-MM-DD format. Omit for latest value only"),
  endDate: dateString.optional().describe("End date in YYYY-MM-DD format. Required if startDate is provided"),
  aggregation: z5.enum(["daily", "weekly", "monthly"]).default("daily").optional().describe("Aggregation type: daily, weekly, or monthly. Defaults to daily")
});
var getScoreSchema = z5.object({
  startDate: dateString.describe("Start date in YYYY-MM-DD format. If endDate is omitted, treated as single day"),
  endDate: dateString.optional().describe("End date in YYYY-MM-DD format. Omit for single-day view"),
  aggregation: z5.enum(["daily", "weekly", "monthly"]).optional().describe("Aggregation for range mode: daily, weekly, or monthly. Only used when endDate is provided")
});
var getTrainingPlanSchema = z5.object({
  planId: z5.string().describe("The training plan ID")
});
var getScheduledWorkoutSchema = z5.object({
  workoutId: z5.string().describe("The scheduled workout ID")
});

// src/dtos/wellness.dto.ts
import { z as z6 } from "zod";
var getMenstrualCalendarSchema = z6.object({
  startDate: dateString.describe("Start date in YYYY-MM-DD format"),
  endDate: dateString.describe("End date in YYYY-MM-DD format")
});

// src/dtos/write.dto.ts
import { z as z7 } from "zod";
var setActivityNameSchema = z7.object({
  activityId: z7.number().positive().describe("The Garmin activity ID"),
  name: z7.string().describe("New name for the activity")
});
var createManualActivitySchema = z7.object({
  activityName: z7.string().describe('Name for the activity (e.g. "Morning Run")'),
  activityTypeKey: z7.string().describe("Activity type key (e.g. running, cycling, swimming). Use get_activity_types to see all options"),
  startTimeInGMT: z7.string().describe('Start time in ISO 8601 format in GMT (e.g. "2024-01-15T08:30:00.000")'),
  elapsedDurationInSecs: z7.number().positive().describe("Duration in seconds"),
  distanceInMeters: z7.number().min(0).optional().describe("Distance in meters. Optional")
});
var deleteActivitySchema = z7.object({
  activityId: z7.number().positive().describe("The Garmin activity ID to delete")
});
var addWeighInSchema = z7.object({
  weight: z7.number().positive().max(700).describe("Weight value"),
  unitKey: z7.enum(["kg", "lbs"]).default("kg").optional().describe("Weight unit: kg or lbs. Defaults to kg"),
  date: dateString.optional().describe("Date in YYYY-MM-DD format. Defaults to today")
});
var setHydrationSchema = z7.object({
  date: dateString.optional().describe("Date in YYYY-MM-DD format. Defaults to today"),
  valueMl: z7.number().min(0).max(2e4).describe("Hydration value in milliliters")
});
var setBloodPressureSchema = z7.object({
  systolic: z7.number().positive().max(300).describe("Systolic pressure (mmHg)"),
  diastolic: z7.number().positive().max(200).describe("Diastolic pressure (mmHg)"),
  pulse: z7.number().positive().max(300).describe("Pulse rate (bpm)"),
  timestamp: z7.string().optional().describe("Measurement timestamp in ISO 8601 format. Defaults to now"),
  notes: z7.string().optional().describe("Optional notes about the measurement")
});
var gearActivitySchema = z7.object({
  gearUuid: z7.string().uuid().describe("The UUID of the gear item"),
  activityId: z7.number().positive().describe("The Garmin activity ID")
});

// src/tools/activities.tools.ts
function registerActivityTools(server2, client2) {
  server2.registerTool(
    "get_activities",
    {
      description: "Get recent activities with pagination. Returns activity summaries: type, duration, distance, calories, heart rate",
      inputSchema: getActivitiesSchema.shape
    },
    async ({ start, limit, activityType }) => {
      const data = await client2.getActivities(start ?? 0, limit ?? DEFAULT_ACTIVITIES_LIMIT, activityType);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activities_by_date",
    {
      description: "Search activities within a date range, optionally filtered by activity type (running, cycling, etc.)",
      inputSchema: getActivitiesByDateSchema.shape
    },
    async ({ startDate, endDate, activityType }) => {
      const data = await client2.getActivitiesByDate(startDate, endDate, activityType);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_last_activity",
    {
      description: "Get the most recent activity"
    },
    async () => {
      const data = await client2.getLastActivity();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "count_activities",
    {
      description: "Get total number of activities"
    },
    async () => {
      const data = await client2.countActivities();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity",
    {
      description: "Get summary data for a specific activity",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivity(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_details",
    {
      description: "Get detailed activity metrics: HR, pace, elevation, cadence, power time series data",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityDetails(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_splits",
    {
      description: "Get per-km or per-mile split data for an activity",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivitySplits(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_weather",
    {
      description: "Get weather conditions during an activity: temperature, humidity, wind, condition",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityWeather(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_hr_zones",
    {
      description: "Get time spent in each heart rate zone during an activity",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityHrZones(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_exercise_sets",
    {
      description: "Get exercise set details for strength training activities: reps, weight, duration per set",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityExerciseSets(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_types",
    {
      description: "Get all available activity types (running, cycling, swimming, etc.)"
    },
    async () => {
      const data = await client2.getActivityTypes();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_gear",
    {
      description: "Get gear/equipment used during a specific activity",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityGear(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_typed_splits",
    {
      description: "Get typed split data for an activity (e.g. active vs rest intervals)",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityTypedSplits(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_split_summaries",
    {
      description: "Get split summary data for an activity with aggregate stats per split",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivitySplitSummaries(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_activity_power_in_timezones",
    {
      description: "Get power time in zones for cycling/running power activities",
      inputSchema: getActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.getActivityPowerInTimezones(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_progress_summary",
    {
      description: "Get fitness progress stats over a date range: distance, duration, or calories grouped by activity type",
      inputSchema: getProgressSummarySchema.shape
    },
    async ({ startDate, endDate, metric }) => {
      const data = await client2.getProgressSummary(startDate, endDate, metric ?? "distance");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/health.tools.ts
function registerHealthTools(server2, client2) {
  server2.registerTool(
    "get_daily_summary",
    {
      description: "Get full daily summary: steps, calories, distance, floors, active minutes, heart rate, stress, body battery",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getDailySummary(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_steps",
    {
      description: "Get step count for a specific date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getDailySummary(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_steps_chart",
    {
      description: "Get detailed intraday step data throughout the day (step chart)",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getStepsChart(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_heart_rate",
    {
      description: "Get daily heart rate data: resting HR, max HR, min HR, and time series throughout the day",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getHeartRate(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_resting_heart_rate",
    {
      description: "Get resting heart rate data for a specific date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getRestingHeartRate(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_stress",
    {
      description: "Get daily stress levels: overall score, time in rest/low/medium/high stress, and time series. Single date; for ranges use get_stress_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getStress(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_body_battery",
    {
      description: "Get Body Battery energy levels: charged, drained, highest, lowest. endDate defaults to startDate if omitted",
      inputSchema: dateRangeOptionalEndSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getBodyBattery(startDate, endDate ?? startDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_body_battery_events",
    {
      description: "Get Body Battery charge and drain events for a day (what charged/drained your battery)",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getBodyBatteryEvents(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_respiration",
    {
      description: "Get daily respiration rate data throughout the day. Single date; for ranges use get_respiration_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getRespiration(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_spo2",
    {
      description: "Get blood oxygen saturation (SpO2) data for a specific date. Single date; for ranges use get_spo2_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getSpO2(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_intensity_minutes",
    {
      description: "Get moderate and vigorous intensity minutes for a date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getIntensityMinutes(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_floors",
    {
      description: "Get floors climbed chart data for a specific date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getFloors(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_hydration",
    {
      description: "Get daily hydration data (water intake)",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getHydration(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_daily_events",
    {
      description: "Get daily wellness events for a specific date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getDailyEvents(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/trends.tools.ts
function registerTrendTools(server2, client2) {
  server2.registerTool(
    "get_daily_steps_range",
    {
      description: "Get daily step counts over a date range for trend analysis. Auto-chunks ranges >28 days",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getDailySteps(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_weekly_steps",
    {
      description: "Get weekly aggregated step counts for trend analysis. Defaults to 52 weeks (1 year). Max 52 weeks",
      inputSchema: weeklyParamSchema.shape
    },
    async ({ endDate, weeks }) => {
      const data = await client2.getWeeklySteps(endDate, weeks ?? 52);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_weekly_stress",
    {
      description: "Get weekly aggregated stress data for trend analysis. Defaults to 52 weeks (1 year). Max 52 weeks",
      inputSchema: weeklyParamSchema.shape
    },
    async ({ endDate, weeks }) => {
      const data = await client2.getWeeklyStress(endDate, weeks ?? 52);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_weekly_intensity_minutes",
    {
      description: "Get weekly intensity minutes over a date range",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getWeeklyIntensityMinutes(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/sleep.tools.ts
function registerSleepTools(server2, client2) {
  server2.registerTool(
    "get_sleep_data",
    {
      description: "Get detailed sleep data for a single night: duration, sleep stages (deep, light, REM, awake), sleep score, bed/wake times. For multiple nights use get_sleep_data_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getSleepData(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_sleep_data_raw",
    {
      description: "Get raw sleep data directly from the wellness service with full detail including heart rate and SpO2 during sleep",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getSleepDataRaw(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/body.tools.ts
function registerBodyTools(server2, client2) {
  server2.registerTool(
    "get_body_composition",
    {
      description: "Get body composition data over a date range: weight, BMI, body fat %, muscle mass, bone mass, body water %",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getBodyComposition(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_latest_weight",
    {
      description: "Get the most recent weight entry"
    },
    async () => {
      const data = await client2.getDailyWeighIns();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_daily_weigh_ins",
    {
      description: "Get all weigh-in entries for a specific date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getDailyWeighIns(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_weigh_ins",
    {
      description: "Get weigh-in records over a date range",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getWeighIns(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_blood_pressure",
    {
      description: "Get blood pressure readings over a date range",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getBloodPressure(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/performance.tools.ts
function registerPerformanceTools(server2, client2) {
  server2.registerTool(
    "get_vo2max",
    {
      description: "Get VO2 Max estimate for a date (running and cycling). Data may not be available for today, use yesterday. For ranges use get_vo2max_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getVO2Max(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_training_readiness",
    {
      description: "Get Training Readiness score: combines sleep, recovery, training load and HRV. Data may not be available for today, use yesterday. For ranges use get_training_readiness_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getTrainingReadiness(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_training_status",
    {
      description: "Get Training Status: productive, maintaining, detraining, peaking, recovery, overreaching. Includes training load. Data may not be available for today",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getTrainingStatus(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_hrv",
    {
      description: "Get Heart Rate Variability (HRV) data. Key recovery indicator. Data may not be available for today, use yesterday. For ranges use get_hrv_range",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getHRV(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_endurance_score",
    {
      description: "Get Endurance Score. Single date: omit endDate. Date range: provide both with optional aggregation (daily/weekly/monthly)",
      inputSchema: getScoreSchema.shape
    },
    async ({ startDate, endDate, aggregation }) => {
      const data = await client2.getEnduranceScore(startDate, endDate, aggregation);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_hill_score",
    {
      description: "Get Hill Score. Single date: omit endDate. Date range: provide both with optional aggregation (daily/weekly/monthly)",
      inputSchema: getScoreSchema.shape
    },
    async ({ startDate, endDate, aggregation }) => {
      const data = await client2.getHillScore(startDate, endDate, aggregation);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_race_predictions",
    {
      description: "Get race time predictions for 5K, 10K, half marathon, and marathon. Omit dates for latest. Provide dates for historical (daily/monthly)",
      inputSchema: getRacePredictionsSchema.shape
    },
    async ({ startDate, endDate, type }) => {
      const data = await client2.getRacePredictions(startDate, endDate, type ?? "daily");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_fitness_age",
    {
      description: "Get Garmin Fitness Age estimate based on fitness level, activity, and body metrics",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getFitnessAge(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_personal_records",
    {
      description: "Get personal records: longest run, fastest 5K/10K/half/full marathon, longest ride"
    },
    async () => {
      const data = await client2.getPersonalRecords();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_lactate_threshold",
    {
      description: "Get lactate threshold data: HR and pace. Omit dates for latest. Provide dates for historical trend with aggregation (daily/weekly/monthly)",
      inputSchema: getLactateThresholdSchema.shape
    },
    async ({ startDate, endDate, aggregation }) => {
      const data = await client2.getLactateThreshold(startDate, endDate, aggregation ?? "daily");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_cycling_ftp",
    {
      description: "Get latest Functional Threshold Power (FTP) for cycling"
    },
    async () => {
      const data = await client2.getCyclingFTP();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/profile.tools.ts
function registerProfileTools(server2, client2) {
  server2.registerTool(
    "get_user_profile",
    {
      description: "Get user social profile: name, location, profile image, activity preferences, level"
    },
    async () => {
      const data = await client2.getUserProfile();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_user_settings",
    {
      description: "Get user settings: measurement system, time/date format, sleep schedule, HR zones, hydration preferences"
    },
    async () => {
      const data = await client2.getUserSettings();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_devices",
    {
      description: "Get all registered Garmin devices: model, firmware, last sync"
    },
    async () => {
      const data = await client2.getDevices();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_device_settings",
    {
      description: "Get settings and configuration for a specific Garmin device",
      inputSchema: getDeviceSettingsSchema.shape
    },
    async ({ deviceId }) => {
      const data = await client2.getDeviceSettings(deviceId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_device_last_used",
    {
      description: "Get the last used Garmin device info"
    },
    async () => {
      const data = await client2.getDeviceLastUsed();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_primary_training_device",
    {
      description: "Get the primary training device info"
    },
    async () => {
      const data = await client2.getPrimaryTrainingDevice();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_device_solar_data",
    {
      description: "Get solar charging data for solar-equipped Garmin devices",
      inputSchema: getDeviceSolarSchema.shape
    },
    async ({ deviceId, startDate, endDate }) => {
      const data = await client2.getDeviceSolarData(deviceId, startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_gear",
    {
      description: "Get all gear/equipment: shoes, bikes, and other tracked equipment"
    },
    async () => {
      const data = await client2.getGear();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_gear_stats",
    {
      description: "Get usage statistics for a specific gear item (total distance, activities)",
      inputSchema: getGearStatsSchema.shape
    },
    async ({ gearUuid }) => {
      const data = await client2.getGearStats(gearUuid);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_goals",
    {
      description: "Get active goals: step goals, activity goals, weight goals, and their progress"
    },
    async () => {
      const data = await client2.getGoals();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_earned_badges",
    {
      description: "Get all earned badges and achievements"
    },
    async () => {
      const data = await client2.getEarnedBadges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_workouts",
    {
      description: "Get saved workouts/training plans"
    },
    async () => {
      const data = await client2.getWorkouts();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_workout",
    {
      description: "Get a specific workout definition by ID",
      inputSchema: getWorkoutSchema.shape
    },
    async ({ workoutId }) => {
      const data = await client2.getWorkout(workoutId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_gear_activities",
    {
      description: "Get activities associated with a specific gear item (e.g. runs with a specific pair of shoes)",
      inputSchema: getGearActivitiesSchema.shape
    },
    async ({ gearUuid, start, limit }) => {
      const data = await client2.getGearActivities(gearUuid, start ?? 0, limit ?? 20);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_gear_defaults",
    {
      description: "Get default gear assignments per activity type"
    },
    async () => {
      const data = await client2.getGearDefaults();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/range.tools.ts
function registerRangeTools(server2, client2) {
  server2.registerTool(
    "get_sleep_data_range",
    {
      description: "Get sleep data over a date range (day-by-day). Returns array of {date, data} records with sleep stages, score, duration",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getSleepDataRange(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_hrv_range",
    {
      description: "Get HRV data over a date range (day-by-day). Returns array of {date, data} records",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getHRVRange(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_stress_range",
    {
      description: "Get daily stress data over a date range (day-by-day). Returns array of {date, data} records",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getStressRange(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_spo2_range",
    {
      description: "Get SpO2 (blood oxygen) data over a date range (day-by-day). Returns array of {date, data} records",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getSpO2Range(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_respiration_range",
    {
      description: "Get respiration data over a date range (day-by-day). Returns array of {date, data} records",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getRespirationRange(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_training_readiness_range",
    {
      description: "Get Training Readiness data over a date range (day-by-day). Returns array of {date, data} records",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getTrainingReadinessRange(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_vo2max_range",
    {
      description: "Get VO2 Max data over a date range (day-by-day). Returns array of {date, data} records",
      inputSchema: dateRangeParamSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getVO2MaxRange(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/snapshot.tools.ts
function registerSnapshotTools(server2, client2) {
  server2.registerTool(
    "get_daily_health_snapshot",
    {
      description: "Get complete daily health snapshot in a single call: summary, heart rate, stress, body battery, sleep, HRV, respiration, SpO2, steps, floors, intensity minutes. Calls ~11 endpoints in parallel. Use yesterday if today has no data yet",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getDailyHealthSnapshot(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/training.tools.ts
function registerTrainingTools(server2, client2) {
  server2.registerTool(
    "get_training_plans",
    {
      description: "Get all training plans from Garmin Coach or custom plans"
    },
    async () => {
      const data = await client2.getTrainingPlans();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_training_plan_by_id",
    {
      description: "Get a specific training plan by ID with full schedule and workout details",
      inputSchema: getTrainingPlanSchema.shape
    },
    async ({ planId }) => {
      const data = await client2.getTrainingPlan(planId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_adaptive_training_plan_by_id",
    {
      description: "Get an adaptive (Garmin Coach) training plan by ID",
      inputSchema: getTrainingPlanSchema.shape
    },
    async ({ planId }) => {
      const data = await client2.getAdaptiveTrainingPlan(planId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_scheduled_workout_by_id",
    {
      description: "Get a specific scheduled workout by ID from a training plan",
      inputSchema: getScheduledWorkoutSchema.shape
    },
    async ({ workoutId }) => {
      const data = await client2.getScheduledWorkout(workoutId);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/wellness.tools.ts
function registerWellnessTools(server2, client2) {
  server2.registerTool(
    "get_menstrual_calendar_data",
    {
      description: "Get menstrual cycle calendar data for a date range: cycle phases, predictions, symptoms",
      inputSchema: getMenstrualCalendarSchema.shape
    },
    async ({ startDate, endDate }) => {
      const data = await client2.getMenstrualCalendar(startDate, endDate);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_menstrual_data_for_date",
    {
      description: "Get menstrual cycle day view for a specific date: current phase, symptoms, predictions",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getMenstrualDataForDate(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_pregnancy_summary",
    {
      description: "Get pregnancy tracking summary data"
    },
    async () => {
      const data = await client2.getPregnancySummary();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_lifestyle_logging_data",
    {
      description: "Get daily lifestyle logging data for a date",
      inputSchema: dateParamSchema.shape
    },
    async ({ date }) => {
      const data = await client2.getLifestyleLoggingData(date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/challenges.tools.ts
function registerChallengeTools(server2, client2) {
  server2.registerTool(
    "get_available_badges",
    {
      description: "Get all available badges that can be earned"
    },
    async () => {
      const data = await client2.getAvailableBadges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_adhoc_challenges",
    {
      description: "Get historical ad-hoc challenges the user has participated in"
    },
    async () => {
      const data = await client2.getAdhocChallenges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_badge_challenges",
    {
      description: "Get completed badge challenges"
    },
    async () => {
      const data = await client2.getBadgeChallenges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_available_badge_challenges",
    {
      description: "Get available badge challenges that can be joined"
    },
    async () => {
      const data = await client2.getAvailableBadgeChallenges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_non_completed_badge_challenges",
    {
      description: "Get badge challenges that are started but not yet completed"
    },
    async () => {
      const data = await client2.getNonCompletedBadgeChallenges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "get_inprogress_virtual_challenges",
    {
      description: "Get virtual challenges currently in progress"
    },
    async () => {
      const data = await client2.getInProgressVirtualChallenges();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
}

// src/tools/write.tools.ts
function registerWriteTools(server2, client2) {
  server2.registerTool(
    "set_activity_name",
    {
      description: "Rename an activity",
      inputSchema: setActivityNameSchema.shape
    },
    async ({ activityId, name }) => {
      const data = await client2.setActivityName(activityId, name);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "create_manual_activity",
    {
      description: "Create a manual activity entry. Use get_activity_types to find valid activityTypeKey values",
      inputSchema: createManualActivitySchema.shape
    },
    async ({ activityName, activityTypeKey, startTimeInGMT, elapsedDurationInSecs, distanceInMeters }) => {
      const data = await client2.createManualActivity({
        activityName,
        activityTypeKey,
        startTimeInGMT,
        elapsedDurationInSecs,
        distanceInMeters
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "delete_activity",
    {
      description: "Delete an activity permanently. This action cannot be undone",
      inputSchema: deleteActivitySchema.shape
    },
    async ({ activityId }) => {
      const data = await client2.deleteActivity(activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data ?? "Activity deleted", null, 2) }]
      };
    }
  );
  server2.registerTool(
    "add_weigh_in",
    {
      description: "Record a weight measurement",
      inputSchema: addWeighInSchema.shape
    },
    async ({ weight, unitKey, date }) => {
      const data = await client2.addWeighIn(weight, unitKey ?? "kg", date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "set_hydration",
    {
      description: "Set daily hydration intake in milliliters",
      inputSchema: setHydrationSchema.shape
    },
    async ({ valueMl, date }) => {
      const data = await client2.setHydration(valueMl, date);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "set_blood_pressure",
    {
      description: "Record a blood pressure measurement with systolic, diastolic, and pulse",
      inputSchema: setBloodPressureSchema.shape
    },
    async ({ systolic, diastolic, pulse, timestamp, notes }) => {
      const data = await client2.setBloodPressure(systolic, diastolic, pulse, timestamp, notes);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
      };
    }
  );
  server2.registerTool(
    "add_gear_to_activity",
    {
      description: "Link a gear item (shoes, bike) to an activity",
      inputSchema: gearActivitySchema.shape
    },
    async ({ gearUuid, activityId }) => {
      const data = await client2.addGearToActivity(gearUuid, activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data ?? "Gear linked", null, 2) }]
      };
    }
  );
  server2.registerTool(
    "remove_gear_from_activity",
    {
      description: "Unlink a gear item from an activity",
      inputSchema: gearActivitySchema.shape
    },
    async ({ gearUuid, activityId }) => {
      const data = await client2.removeGearFromActivity(gearUuid, activityId);
      return {
        content: [{ type: "text", text: JSON.stringify(data ?? "Gear unlinked", null, 2) }]
      };
    }
  );
}

// src/index.ts
var GARMIN_EMAIL = process.env.GARMIN_EMAIL;
var GARMIN_PASSWORD = process.env.GARMIN_PASSWORD;
if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
  console.error(
    "Error: GARMIN_EMAIL and GARMIN_PASSWORD environment variables are required.\nSet them when adding this MCP server:\n  claude mcp add garmin -e GARMIN_EMAIL=you@email.com -e GARMIN_PASSWORD=yourpass -- npx -y @nicolasvegam/garmin-connect-mcp"
  );
  process.exit(1);
}
var server = new McpServer({
  name: "garmin-connect-mcp",
  version: "1.0.0"
});
var client = new GarminClient(GARMIN_EMAIL, GARMIN_PASSWORD);
registerActivityTools(server, client);
registerHealthTools(server, client);
registerTrendTools(server, client);
registerSleepTools(server, client);
registerBodyTools(server, client);
registerPerformanceTools(server, client);
registerProfileTools(server, client);
registerRangeTools(server, client);
registerSnapshotTools(server, client);
registerTrainingTools(server, client);
registerWellnessTools(server, client);
registerChallengeTools(server, client);
registerWriteTools(server, client);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Garmin Connect MCP server running on stdio");
}
main().catch((error) => {
  console.error("Fatal error starting server:", error);
  process.exit(1);
});
