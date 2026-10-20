#!/usr/bin/env node

// src/client/garmin-auth.ts
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
var OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
var SSO_EMBED = "https://sso.garmin.com/sso/embed";
var SSO_SIGNIN = "https://sso.garmin.com/sso/signin";
var SSO_ORIGIN = "https://sso.garmin.com";
var GARMIN_CONNECT_API = "https://connectapi.garmin.com";
var OAUTH_PREAUTHORIZED = `${GARMIN_CONNECT_API}/oauth-service/oauth/preauthorized`;
var OAUTH_EXCHANGE = `${GARMIN_CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
var PROFILE_URL = `${GARMIN_CONNECT_API}/userprofile-service/socialProfile`;
var SSO_CLIENT_ID = "GarminConnect";
var SSO_LOCALE = "en";
var SSO_WIDGET_ID = "gauth-widget";
var USER_AGENT_MOBILE = "com.garmin.android.apps.connectmobile";
var USER_AGENT_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var CSRF_REGEX = /name="_csrf"\s+value="(.+?)"/;
var TICKET_REGEX = /ticket=([^"]+)"/;
var TITLE_REGEX = /<title>(.+?)<\/title>/;
var SSO_VERIFY_MFA = "https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode";
var OAUTH1_TOKEN_FILE = "oauth1_token.json";
var OAUTH2_TOKEN_FILE = "oauth2_token.json";
var PROFILE_FILE = "profile.json";
var MAX_REQUEST_RETRIES = 3;
var TOKEN_EXPIRY_BUFFER_SECONDS = 60;
function getGarminTokenDirectory(email, home = os.homedir(), baseDirectory) {
  const accountKey = crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return path.join(baseDirectory || path.join(home, ".garmin-mcp"), accountKey);
}
var GarminAuth = class {
  email;
  password;
  consumer = null;
  oauth1Token = null;
  oauth2Token = null;
  profile = null;
  isAuthenticated = false;
  promptMfa;
  tokenDir;
  authentication = null;
  get displayName() {
    return this.profile?.displayName ?? "";
  }
  get userProfilePk() {
    return this.profile?.profileId ?? 0;
  }
  constructor(email, password, promptMfa) {
    this.email = email;
    this.password = password;
    this.promptMfa = promptMfa;
    this.tokenDir = getGarminTokenDirectory(email, os.homedir(), process.env.GARMIN_TOKEN_DIR);
    if (process.env.GARMIN_FORCE_LOGIN !== "1") this.loadTokens();
  }
  async request(endpoint, options) {
    await this.ensureAuthenticated();
    const url = endpoint.startsWith("http") ? endpoint : `${GARMIN_CONNECT_API}${endpoint}`;
    const method = (options?.method ?? "GET").toUpperCase();
    const reqHeaders = {
      Authorization: `Bearer ${this.oauth2Token.access_token}`,
      "User-Agent": USER_AGENT_MOBILE,
      ...options?.headers
    };
    if (options?.body && !reqHeaders["Content-Type"]) {
      reqHeaders["Content-Type"] = "application/json";
    }
    for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt++) {
      try {
        const response = await axios({
          url,
          method,
          headers: reqHeaders,
          data: options?.body
        });
        return response.data;
      } catch (error) {
        if (!axios.isAxiosError(error)) throw error;
        const status = error.response?.status;
        if (status === 401 && attempt === 0) {
          await this.refreshOrRelogin();
          reqHeaders.Authorization = `Bearer ${this.oauth2Token.access_token}`;
          continue;
        }
        if ((status === 429 || status && status >= 500) && attempt < MAX_REQUEST_RETRIES) {
          const delay = Math.pow(2, attempt) * 1e3;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Max retries exceeded");
  }
  async ensureAuthenticated() {
    if (this.isAuthenticated && this.oauth2Token && !this.isOAuth2Expired() && this.profile) return;
    if (this.authentication) return this.authentication;
    this.authentication = this.authenticate();
    try {
      await this.authentication;
    } finally {
      this.authentication = null;
    }
  }
  async authenticate() {
    if (this.oauth1Token && this.oauth2Token && !this.isOAuth2Expired() && this.profile) {
      this.isAuthenticated = true;
      return;
    }
    if (this.oauth1Token && this.oauth2Token && !this.isOAuth2Expired() && !this.profile) {
      await this.fetchProfile();
      this.saveTokens();
      this.isAuthenticated = true;
      return;
    }
    if (this.oauth1Token) {
      await this.exchangeOAuth1ForOAuth2();
      await this.fetchProfile();
      this.saveTokens();
      this.isAuthenticated = true;
      return;
    }
    await this.login();
    this.isAuthenticated = true;
  }
  async refreshOrRelogin() {
    this.isAuthenticated = false;
    if (this.oauth1Token) {
      try {
        await this.exchangeOAuth1ForOAuth2();
        if (!this.profile) await this.fetchProfile();
        this.saveTokens();
        this.isAuthenticated = true;
        return;
      } catch (error) {
        console.error("OAuth2 refresh failed, will re-login:", error);
      }
    }
    await this.login();
    this.isAuthenticated = true;
  }
  async login() {
    console.error("Authenticating with Garmin Connect...");
    await this.fetchOAuthConsumer();
    const ticket = await this.getLoginTicket();
    await this.exchangeTicketForOAuth1(ticket);
    await this.exchangeOAuth1ForOAuth2();
    await this.fetchProfile();
    this.saveTokens();
    console.error("Authentication successful");
  }
  async fetchProfile() {
    const response = await axios.get(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${this.oauth2Token.access_token}`,
        "User-Agent": USER_AGENT_MOBILE
      }
    });
    const displayName = response.data.displayName;
    const profileId = response.data.profileId ?? response.data.userProfileNumber;
    if (!displayName) throw new Error("Failed to get display name from profile");
    this.profile = { displayName, profileId };
  }
  async fetchOAuthConsumer() {
    if (this.consumer) return;
    const response = await axios.get(OAUTH_CONSUMER_URL);
    this.consumer = response.data;
  }
  async getLoginTicket() {
    const jar = new CookieJar();
    const ssoClient = wrapper(axios.create({ jar, withCredentials: true }));
    await ssoClient.get(SSO_EMBED, {
      params: { clientId: SSO_CLIENT_ID, locale: SSO_LOCALE, service: SSO_EMBED },
      headers: { "User-Agent": USER_AGENT_BROWSER }
    });
    const signinParams = {
      id: SSO_WIDGET_ID,
      embedWidget: true,
      locale: SSO_LOCALE,
      gauthHost: SSO_EMBED
    };
    const signinResponse = await ssoClient.get(SSO_SIGNIN, {
      params: signinParams,
      headers: { "User-Agent": USER_AGENT_BROWSER }
    });
    const csrfMatch = CSRF_REGEX.exec(signinResponse.data);
    if (!csrfMatch) throw new Error("Failed to extract CSRF token from SSO");
    const csrfToken = csrfMatch[1];
    const loginResponse = await ssoClient.post(SSO_SIGNIN, new URLSearchParams({
      username: this.email,
      password: this.password,
      embed: "true",
      _csrf: csrfToken
    }).toString(), {
      params: {
        ...signinParams,
        clientId: SSO_CLIENT_ID,
        service: SSO_EMBED,
        source: SSO_EMBED,
        redirectAfterAccountLoginUrl: SSO_EMBED,
        redirectAfterAccountCreationUrl: SSO_EMBED
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT_BROWSER,
        Origin: SSO_ORIGIN,
        Referer: SSO_SIGNIN,
        Dnt: "1"
      }
    });
    let responseHtml = loginResponse.data;
    const titleMatch = TITLE_REGEX.exec(responseHtml);
    const title = titleMatch?.[1] ?? "";
    if (title.includes("MFA")) {
      if (!this.promptMfa) {
        throw new Error(
          'MFA is required but no MFA handler is available. Run "npx @nicolasvegam/garmin-connect-mcp setup" to authenticate interactively.'
        );
      }
      const mfaCsrfMatch = CSRF_REGEX.exec(responseHtml);
      if (!mfaCsrfMatch) throw new Error("Failed to extract CSRF token for MFA");
      const mfaCode = await this.promptMfa();
      const mfaResponse = await ssoClient.post(SSO_VERIFY_MFA, new URLSearchParams({
        "mfa-code": mfaCode,
        embed: "true",
        _csrf: mfaCsrfMatch[1],
        fromPage: "setupEnterMfaCode"
      }).toString(), {
        params: {
          ...signinParams,
          clientId: SSO_CLIENT_ID,
          service: SSO_EMBED,
          source: SSO_EMBED,
          redirectAfterAccountLoginUrl: SSO_EMBED,
          redirectAfterAccountCreationUrl: SSO_EMBED
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT_BROWSER,
          Origin: SSO_ORIGIN,
          Referer: SSO_SIGNIN,
          Dnt: "1"
        }
      });
      responseHtml = mfaResponse.data;
    }
    const ticketMatch = TICKET_REGEX.exec(responseHtml);
    if (!ticketMatch) throw new Error("Login failed: invalid credentials or MFA verification failed");
    return ticketMatch[1];
  }
  async exchangeTicketForOAuth1(ticket) {
    await this.fetchOAuthConsumer();
    const oauth = new OAuth({
      consumer: { key: this.consumer.consumer_key, secret: this.consumer.consumer_secret },
      signature_method: "HMAC-SHA1",
      hash_function: (baseString, key) => crypto.createHmac("sha1", key).update(baseString).digest("base64")
    });
    const url = `${OAUTH_PREAUTHORIZED}?${new URLSearchParams({
      ticket,
      "login-url": SSO_EMBED,
      "accepts-mfa-tokens": "true"
    })}`;
    const requestData = { url, method: "GET" };
    const authHeader = oauth.toHeader(oauth.authorize(requestData));
    const response = await axios.get(url, {
      headers: {
        ...authHeader,
        "User-Agent": USER_AGENT_MOBILE
      }
    });
    const params = new URLSearchParams(response.data);
    const oauthToken = params.get("oauth_token");
    const oauthTokenSecret = params.get("oauth_token_secret");
    if (!oauthToken || !oauthTokenSecret) {
      throw new Error("Failed to obtain OAuth1 token");
    }
    this.oauth1Token = { oauth_token: oauthToken, oauth_token_secret: oauthTokenSecret };
  }
  async exchangeOAuth1ForOAuth2() {
    await this.fetchOAuthConsumer();
    if (!this.oauth1Token) throw new Error("OAuth1 token required for OAuth2 exchange");
    const oauth = new OAuth({
      consumer: { key: this.consumer.consumer_key, secret: this.consumer.consumer_secret },
      signature_method: "HMAC-SHA1",
      hash_function: (baseString, key) => crypto.createHmac("sha1", key).update(baseString).digest("base64")
    });
    const token = {
      key: this.oauth1Token.oauth_token,
      secret: this.oauth1Token.oauth_token_secret
    };
    const requestData = { url: OAUTH_EXCHANGE, method: "POST" };
    const authData = oauth.authorize(requestData, token);
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(authData)) {
      queryParams.set(key, String(value));
    }
    const response = await axios.post(
      `${OAUTH_EXCHANGE}?${queryParams}`,
      null,
      {
        headers: {
          "User-Agent": USER_AGENT_MOBILE,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
    const now = Math.floor(Date.now() / 1e3);
    this.oauth2Token = {
      ...response.data,
      expires_at: now + response.data.expires_in,
      refresh_token_expires_at: now + response.data.refresh_token_expires_in
    };
  }
  isOAuth2Expired() {
    if (!this.oauth2Token) return true;
    return this.oauth2Token.expires_at < Math.floor(Date.now() / 1e3) + TOKEN_EXPIRY_BUFFER_SECONDS;
  }
  loadTokens() {
    try {
      const oauth1Path = path.join(this.tokenDir, OAUTH1_TOKEN_FILE);
      const oauth2Path = path.join(this.tokenDir, OAUTH2_TOKEN_FILE);
      const profilePath = path.join(this.tokenDir, PROFILE_FILE);
      if (fs.existsSync(oauth1Path)) {
        this.oauth1Token = JSON.parse(fs.readFileSync(oauth1Path, "utf-8"));
      }
      if (fs.existsSync(oauth2Path)) {
        this.oauth2Token = JSON.parse(fs.readFileSync(oauth2Path, "utf-8"));
      }
      if (fs.existsSync(profilePath)) {
        this.profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
      }
    } catch {
      this.oauth1Token = null;
      this.oauth2Token = null;
      this.profile = null;
    }
  }
  saveTokens() {
    if (!fs.existsSync(this.tokenDir)) {
      fs.mkdirSync(this.tokenDir, { recursive: true, mode: 448 });
    }
    if (this.oauth1Token) {
      fs.writeFileSync(
        path.join(this.tokenDir, OAUTH1_TOKEN_FILE),
        JSON.stringify(this.oauth1Token, null, 2),
        { mode: 384 }
      );
    }
    if (this.oauth2Token) {
      fs.writeFileSync(
        path.join(this.tokenDir, OAUTH2_TOKEN_FILE),
        JSON.stringify(this.oauth2Token, null, 2),
        { mode: 384 }
      );
    }
    if (this.profile) {
      fs.writeFileSync(
        path.join(this.tokenDir, PROFILE_FILE),
        JSON.stringify(this.profile, null, 2),
        { mode: 384 }
      );
    }
  }
};

// src/constants/garmin-endpoints.ts
var USER_SUMMARY_ENDPOINT = "/usersummary-service/usersummary/daily";
var HEART_RATE_ENDPOINT = "/wellness-service/wellness/dailyHeartRate";
var STEPS_CHART_ENDPOINT = "/wellness-service/wellness/dailySummaryChart";
var DAILY_STRESS_ENDPOINT = "/wellness-service/wellness/dailyStress";
var DAILY_RESPIRATION_ENDPOINT = "/wellness-service/wellness/daily/respiration";
var DAILY_SPO2_ENDPOINT = "/wellness-service/wellness/daily/spo2";
var DAILY_INTENSITY_MINUTES_ENDPOINT = "/wellness-service/wellness/daily/im";
var FLOORS_CHART_ENDPOINT = "/wellness-service/wellness/floorsChartData/daily";
var DAILY_EVENTS_ENDPOINT = "/wellness-service/wellness/dailyEvents";
var BODY_BATTERY_ENDPOINT = "/wellness-service/wellness/bodyBattery/reports/daily";
var BODY_BATTERY_EVENTS_ENDPOINT = "/wellness-service/wellness/bodyBattery/events";
var SLEEP_DAILY_ENDPOINT = "/wellness-service/wellness/dailySleepData";
var HYDRATION_ENDPOINT = "/usersummary-service/usersummary/hydration/daily";
var RHR_ENDPOINT = "/userstats-service/wellness/daily";
var DAILY_STEPS_ENDPOINT = "/usersummary-service/stats/steps/daily";
var WEEKLY_STEPS_ENDPOINT = "/usersummary-service/stats/steps/weekly";
var WEEKLY_STRESS_ENDPOINT = "/usersummary-service/stats/stress/weekly";
var WEEKLY_INTENSITY_MINUTES_ENDPOINT = "/usersummary-service/stats/im/weekly";
var BODY_COMPOSITION_ENDPOINT = "/weight-service/weight/dateRange";
var WEIGHT_DAY_VIEW_ENDPOINT = "/weight-service/weight/dayview";
var WEIGH_INS_RANGE_ENDPOINT = "/weight-service/weight/range";
var BLOOD_PRESSURE_ENDPOINT = "/bloodpressure-service/bloodpressure/range";
var VO2_MAX_ENDPOINT = "/metrics-service/metrics/maxmet/daily";
var TRAINING_READINESS_ENDPOINT = "/metrics-service/metrics/trainingreadiness";
var TRAINING_STATUS_ENDPOINT = "/metrics-service/metrics/trainingstatus/aggregated";
var HRV_ENDPOINT = "/hrv-service/hrv";
var ENDURANCE_SCORE_ENDPOINT = "/metrics-service/metrics/endurancescore";
var HILL_SCORE_ENDPOINT = "/metrics-service/metrics/hillscore";
var RACE_PREDICTIONS_ENDPOINT = "/metrics-service/metrics/racepredictions";
var FITNESS_AGE_ENDPOINT = "/fitnessage-service/fitnessage";
var PERSONAL_RECORD_ENDPOINT = "/personalrecord-service/personalrecord/prs";
var LACTATE_THRESHOLD_ENDPOINT = "/biometric-service/biometric/latestLactateThreshold";
var CYCLING_FTP_ENDPOINT = "/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING";
var ACTIVITIES_SEARCH_ENDPOINT = "/activitylist-service/activities/search/activities";
var ACTIVITIES_COUNT_ENDPOINT = "/activitylist-service/activities/count";
var ACTIVITY_ENDPOINT = "/activity-service/activity";
var ACTIVITY_TYPES_ENDPOINT = "/activity-service/activity/activityTypes";
var ACTIVITY_DETAILS_SUBPATH = "details";
var ACTIVITY_SPLITS_SUBPATH = "splits";
var ACTIVITY_WEATHER_SUBPATH = "weather";
var ACTIVITY_HR_ZONES_SUBPATH = "hrTimeInZones";
var ACTIVITY_EXERCISE_SETS_SUBPATH = "exerciseSets";
var FITNESS_STATS_ENDPOINT = "/fitnessstats-service/activity";
var USER_PROFILE_ENDPOINT = "/userprofile-service/socialProfile";
var USER_SETTINGS_ENDPOINT = "/userprofile-service/userprofile/user-settings";
var DEVICE_LIST_ENDPOINT = "/device-service/deviceregistration/devices";
var DEVICE_SETTINGS_ENDPOINT = "/device-service/deviceservice/device-info/settings";
var DEVICE_LAST_USED_ENDPOINT = "/device-service/deviceservice/mylastused";
var PRIMARY_TRAINING_DEVICE_ENDPOINT = "/web-gateway/device-info/primary-training-device";
var DEVICE_SOLAR_ENDPOINT = "/web-gateway/solar";
var GEAR_ENDPOINT = "/gear-service/gear/filterGear";
var GEAR_STATS_ENDPOINT = "/gear-service/gear/stats";
var GOALS_ENDPOINT = "/goal-service/goal/goals";
var EARNED_BADGES_ENDPOINT = "/badge-service/badge/earned";
var WORKOUTS_ENDPOINT = "/workout-service/workouts";
var WORKOUT_ENDPOINT = "/workout-service/workout";
var ACTIVITY_DETAILS_MAX_CHART_SIZE = 2e3;
var ACTIVITY_DETAILS_MAX_POLYLINE_SIZE = 4e3;
var RHR_METRIC_ID = 60;
var SLEEP_NON_SLEEP_BUFFER_MINUTES = 60;
var FITNESS_STATS_AGGREGATION = "lifetime";
var DEFAULT_GOALS_STATUS = "active";
var DEFAULT_ACTIVITIES_LIMIT = 20;
var DEFAULT_GOALS_LIMIT = 100;
var DEFAULT_WORKOUTS_LIMIT = 100;
var DEFAULT_ACTIVITIES_BY_DATE_LIMIT = 100;
var ACTIVITY_TYPED_SPLITS_SUBPATH = "typedsplits";
var ACTIVITY_SPLIT_SUMMARIES_SUBPATH = "split_summaries";
var ACTIVITY_POWER_ZONES_SUBPATH = "powerTimeInZones";
var TRAINING_PLANS_ENDPOINT = "/trainingplan-service/trainingplan";
var ADAPTIVE_TRAINING_PLAN_ENDPOINT = "/trainingplan-service/trainingplan/adaptive";
var SCHEDULED_WORKOUT_ENDPOINT = "/workout-service/schedule";
var MENSTRUAL_CALENDAR_ENDPOINT = "/periodichealth-service/menstrualcycle/calendar";
var MENSTRUAL_DAYVIEW_ENDPOINT = "/periodichealth-service/menstrualcycle/dayview";
var PREGNANCY_SNAPSHOT_ENDPOINT = "/periodichealth-service/menstrualcycle/pregnancysnapshot";
var LIFESTYLE_LOGGING_ENDPOINT = "/lifestylelogging-service/dailyLog";
var AVAILABLE_BADGES_ENDPOINT = "/badge-service/badge/available";
var ADHOC_CHALLENGES_ENDPOINT = "/adhocchallenge-service/adHocChallenge/historical";
var BADGE_CHALLENGES_ENDPOINT = "/badgechallenge-service/badgeChallenge/completed";
var AVAILABLE_BADGE_CHALLENGES_ENDPOINT = "/badgechallenge-service/badgeChallenge/available";
var NON_COMPLETED_BADGE_CHALLENGES_ENDPOINT = "/badgechallenge-service/badgeChallenge/non-completed";
var INPROGRESS_VIRTUAL_CHALLENGES_ENDPOINT = "/badgechallenge-service/virtualChallenge/inProgress";
var GEAR_ACTIVITIES_ENDPOINT = "/activitylist-service/activities";
var GEAR_DEFAULTS_ENDPOINT = "/gear-service/gear/user";
var ACTIVITY_GEAR_ENDPOINT = "/gear-service/gear/filterGear";
var ADD_WEIGH_IN_ENDPOINT = "/weight-service/user-weight";
var SET_HYDRATION_ENDPOINT = "/usersummary-service/usersummary/hydration/log";
var SET_BLOOD_PRESSURE_ENDPOINT = "/bloodpressure-service/bloodpressure";
var GEAR_LINK_ENDPOINT = "/gear-service/gear/link";
var GEAR_UNLINK_ENDPOINT = "/gear-service/gear/unlink";
var DAILY_STEPS_MAX_RANGE_DAYS = 28;
var BIOMETRIC_STATS_ENDPOINT = "/biometric-service/stats";
var DEFAULT_GEAR_ACTIVITIES_LIMIT = 20;

// src/client/garmin.client.ts
function todayString() {
  return (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
}
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
var DAILY_SNAPSHOT_CONCURRENCY = 4;
var GarminClient = class {
  auth;
  constructor(email, password, promptMfa) {
    this.auth = new GarminAuth(email, password, promptMfa);
  }
  request(endpoint, options) {
    return this.auth.request(endpoint, options);
  }
  get displayName() {
    return this.auth.displayName;
  }
  get userProfilePk() {
    return this.auth.userProfilePk;
  }
  chunkDateRange(startDate, endDate, maxDays) {
    if (new Date(startDate) > new Date(endDate)) {
      throw new Error(`startDate ${startDate} must not be after endDate ${endDate}`);
    }
    const chunks = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    let chunkStart = new Date(start);
    while (chunkStart <= end) {
      const chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());
      chunks.push({
        start: chunkStart.toISOString().split("T")[0],
        end: chunkEnd.toISOString().split("T")[0]
      });
      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() + 1);
    }
    return chunks;
  }
  dateRange(startDate, endDate) {
    if (new Date(startDate) > new Date(endDate)) {
      throw new Error(`startDate ${startDate} must not be after endDate ${endDate}`);
    }
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      dates.push(current.toISOString().split("T")[0]);
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }
  async fetchRange(startDate, endDate, fetcher) {
    const dates = this.dateRange(startDate, endDate);
    const results = [];
    for (const date of dates) {
      const data = await fetcher(date).catch(() => null);
      results.push({ date, data });
    }
    return results;
  }
  async getActivities(start = 0, limit = DEFAULT_ACTIVITIES_LIMIT, activityType) {
    const params = new URLSearchParams({
      start: String(start),
      limit: String(limit)
    });
    if (activityType) params.set("activityType", activityType);
    return this.request(`${ACTIVITIES_SEARCH_ENDPOINT}?${params}`);
  }
  async getActivitiesByDate(startDate, endDate, activityType) {
    const allActivities = [];
    let start = 0;
    const pageSize = DEFAULT_ACTIVITIES_BY_DATE_LIMIT;
    while (true) {
      const params = new URLSearchParams({
        startDate,
        endDate,
        start: String(start),
        limit: String(pageSize)
      });
      if (activityType) params.set("activityType", activityType);
      const page = await this.request(`${ACTIVITIES_SEARCH_ENDPOINT}?${params}`);
      if (!Array.isArray(page) || page.length === 0) break;
      allActivities.push(...page);
      if (page.length < pageSize) break;
      start += pageSize;
    }
    return allActivities;
  }
  async getLastActivity() {
    return this.request(`${ACTIVITIES_SEARCH_ENDPOINT}?start=0&limit=1`);
  }
  async countActivities() {
    return this.request(ACTIVITIES_COUNT_ENDPOINT);
  }
  async getActivity(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}`);
  }
  async getActivityDetails(activityId) {
    return this.request(
      `${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_DETAILS_SUBPATH}?maxChartSize=${ACTIVITY_DETAILS_MAX_CHART_SIZE}&maxPolylineSize=${ACTIVITY_DETAILS_MAX_POLYLINE_SIZE}`
    );
  }
  async getActivitySplits(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_SPLITS_SUBPATH}`);
  }
  async getActivityWeather(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_WEATHER_SUBPATH}`);
  }
  async getActivityHrZones(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_HR_ZONES_SUBPATH}`);
  }
  async getActivityExerciseSets(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_EXERCISE_SETS_SUBPATH}`);
  }
  async getActivityTypes() {
    return this.request(ACTIVITY_TYPES_ENDPOINT);
  }
  async getProgressSummary(startDate, endDate, metric = "distance") {
    return this.request(
      `${FITNESS_STATS_ENDPOINT}?startDate=${startDate}&endDate=${endDate}&aggregation=${FITNESS_STATS_AGGREGATION}&groupByParentActivityType=true&metric=${metric}`
    );
  }
  async getDailySummary(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${USER_SUMMARY_ENDPOINT}/${this.displayName}?calendarDate=${resolvedDate}`);
  }
  async getStepsChart(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${STEPS_CHART_ENDPOINT}/${this.displayName}?date=${resolvedDate}`);
  }
  async getHeartRate(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${HEART_RATE_ENDPOINT}/${this.displayName}?date=${resolvedDate}`);
  }
  async getRestingHeartRate(date) {
    const resolvedDate = date ?? todayString();
    return this.request(
      `${RHR_ENDPOINT}/${this.displayName}?fromDate=${resolvedDate}&untilDate=${resolvedDate}&metricId=${RHR_METRIC_ID}`
    );
  }
  async getStress(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${DAILY_STRESS_ENDPOINT}/${resolvedDate}`);
  }
  async getBodyBattery(startDate, endDate) {
    return this.request(`${BODY_BATTERY_ENDPOINT}?startDate=${startDate}&endDate=${endDate}`);
  }
  async getBodyBatteryEvents(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${BODY_BATTERY_EVENTS_ENDPOINT}/${resolvedDate}`);
  }
  async getRespiration(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${DAILY_RESPIRATION_ENDPOINT}/${resolvedDate}`);
  }
  async getSpO2(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${DAILY_SPO2_ENDPOINT}/${resolvedDate}`);
  }
  async getIntensityMinutes(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${DAILY_INTENSITY_MINUTES_ENDPOINT}/${resolvedDate}`);
  }
  async getFloors(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${FLOORS_CHART_ENDPOINT}/${resolvedDate}`);
  }
  async getHydration(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${HYDRATION_ENDPOINT}/${resolvedDate}`);
  }
  async getDailyEvents(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${DAILY_EVENTS_ENDPOINT}?calendarDate=${resolvedDate}`);
  }
  async getDailySteps(startDate, endDate) {
    const chunks = this.chunkDateRange(startDate, endDate, DAILY_STEPS_MAX_RANGE_DAYS);
    if (chunks.length === 1) {
      return this.request(`${DAILY_STEPS_ENDPOINT}/${startDate}/${endDate}`);
    }
    const results = [];
    for (const chunk of chunks) {
      const data = await this.request(`${DAILY_STEPS_ENDPOINT}/${chunk.start}/${chunk.end}`);
      if (Array.isArray(data)) {
        results.push(...data);
      } else {
        results.push(data);
      }
    }
    return results;
  }
  async getWeeklySteps(endDate, weeks = 52) {
    return this.request(`${WEEKLY_STEPS_ENDPOINT}/${endDate}/${weeks}`);
  }
  async getWeeklyStress(endDate, weeks = 52) {
    return this.request(`${WEEKLY_STRESS_ENDPOINT}/${endDate}/${weeks}`);
  }
  async getWeeklyIntensityMinutes(startDate, endDate) {
    return this.request(`${WEEKLY_INTENSITY_MINUTES_ENDPOINT}/${startDate}/${endDate}`);
  }
  async getSleepData(date) {
    const resolvedDate = date ?? todayString();
    return this.request(
      `${SLEEP_DAILY_ENDPOINT}/${this.displayName}?date=${resolvedDate}&nonSleepBufferMinutes=${SLEEP_NON_SLEEP_BUFFER_MINUTES}`
    );
  }
  async getSleepDataRaw(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${SLEEP_DAILY_ENDPOINT}/${this.displayName}?date=${resolvedDate}`);
  }
  async getBodyComposition(startDate, endDate) {
    return this.request(`${BODY_COMPOSITION_ENDPOINT}?startDate=${startDate}&endDate=${endDate}`);
  }
  async getDailyWeighIns(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${WEIGHT_DAY_VIEW_ENDPOINT}/${resolvedDate}?includeAll=true`);
  }
  async getWeighIns(startDate, endDate) {
    return this.request(`${WEIGH_INS_RANGE_ENDPOINT}/${startDate}/${endDate}?includeAll=true`);
  }
  async getBloodPressure(startDate, endDate) {
    return this.request(`${BLOOD_PRESSURE_ENDPOINT}/${startDate}/${endDate}`);
  }
  async getVO2Max(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${VO2_MAX_ENDPOINT}/${resolvedDate}/${resolvedDate}`);
  }
  async getTrainingReadiness(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${TRAINING_READINESS_ENDPOINT}/${resolvedDate}`);
  }
  async getTrainingStatus(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${TRAINING_STATUS_ENDPOINT}/${resolvedDate}`);
  }
  async getHRV(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${HRV_ENDPOINT}/${resolvedDate}`);
  }
  async getEnduranceScore(startDate, endDate, aggregation = "weekly") {
    if (!endDate) {
      return this.request(`${ENDURANCE_SCORE_ENDPOINT}?calendarDate=${startDate}`);
    }
    return this.request(
      `${ENDURANCE_SCORE_ENDPOINT}/stats?startDate=${startDate}&endDate=${endDate}&aggregation=${aggregation}`
    );
  }
  async getHillScore(startDate, endDate, aggregation = "daily") {
    if (!endDate) {
      return this.request(`${HILL_SCORE_ENDPOINT}?calendarDate=${startDate}`);
    }
    return this.request(
      `${HILL_SCORE_ENDPOINT}/stats?startDate=${startDate}&endDate=${endDate}&aggregation=${aggregation}`
    );
  }
  async getRacePredictions(startDate, endDate, type = "daily") {
    if (!startDate || !endDate) {
      return this.request(`${RACE_PREDICTIONS_ENDPOINT}/latest/${this.displayName}`);
    }
    return this.request(
      `${RACE_PREDICTIONS_ENDPOINT}/${type}/${this.displayName}?fromCalendarDate=${startDate}&toCalendarDate=${endDate}`
    );
  }
  async getFitnessAge(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${FITNESS_AGE_ENDPOINT}/${resolvedDate}`);
  }
  async getPersonalRecords() {
    return this.request(`${PERSONAL_RECORD_ENDPOINT}/${this.displayName}`);
  }
  async getLactateThreshold(startDate, endDate, aggregation = "daily") {
    if (!startDate || !endDate) {
      return this.request(LACTATE_THRESHOLD_ENDPOINT);
    }
    return this.request(
      `${BIOMETRIC_STATS_ENDPOINT}?startDate=${startDate}&endDate=${endDate}&aggregation=${aggregation}`
    );
  }
  async getCyclingFTP() {
    return this.request(CYCLING_FTP_ENDPOINT);
  }
  async getUserProfile() {
    return this.request(USER_PROFILE_ENDPOINT);
  }
  async getUserSettings() {
    return this.request(USER_SETTINGS_ENDPOINT);
  }
  async getDevices() {
    return this.request(DEVICE_LIST_ENDPOINT);
  }
  async getDeviceSettings(deviceId) {
    return this.request(`${DEVICE_SETTINGS_ENDPOINT}/${deviceId}`);
  }
  async getDeviceLastUsed() {
    return this.request(DEVICE_LAST_USED_ENDPOINT);
  }
  async getPrimaryTrainingDevice() {
    return this.request(PRIMARY_TRAINING_DEVICE_ENDPOINT);
  }
  async getDeviceSolarData(deviceId, startDate, endDate) {
    const singleDay = startDate === endDate ? "&singleDayView=true" : "";
    return this.request(
      `${DEVICE_SOLAR_ENDPOINT}/${deviceId}?startDate=${startDate}&endDate=${endDate}${singleDay}`
    );
  }
  async getGear() {
    return this.request(`${GEAR_ENDPOINT}?userProfilePk=${this.userProfilePk}`);
  }
  async getGearStats(gearUuid) {
    return this.request(`${GEAR_STATS_ENDPOINT}/${gearUuid}`);
  }
  async getGoals(status = DEFAULT_GOALS_STATUS) {
    const allGoals = [];
    let start = 0;
    while (true) {
      const page = await this.request(
        `${GOALS_ENDPOINT}?status=${status}&start=${start}&limit=${DEFAULT_GOALS_LIMIT}&sortOrder=asc`
      );
      if (!Array.isArray(page) || page.length === 0) break;
      allGoals.push(...page);
      if (page.length < DEFAULT_GOALS_LIMIT) break;
      start += DEFAULT_GOALS_LIMIT;
    }
    return allGoals;
  }
  async getEarnedBadges() {
    return this.request(EARNED_BADGES_ENDPOINT);
  }
  async getWorkouts(start = 0, limit = DEFAULT_WORKOUTS_LIMIT) {
    return this.request(`${WORKOUTS_ENDPOINT}?start=${start}&limit=${limit}`);
  }
  async getWorkout(workoutId) {
    return this.request(`${WORKOUT_ENDPOINT}/${workoutId}`);
  }
  async getActivityGear(activityId) {
    return this.request(`${ACTIVITY_GEAR_ENDPOINT}?activityId=${activityId}`);
  }
  async getActivityTypedSplits(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_TYPED_SPLITS_SUBPATH}`);
  }
  async getActivitySplitSummaries(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_SPLIT_SUMMARIES_SUBPATH}`);
  }
  async getActivityPowerInTimezones(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}/${ACTIVITY_POWER_ZONES_SUBPATH}`);
  }
  async getTrainingPlans() {
    return this.request(TRAINING_PLANS_ENDPOINT);
  }
  async getTrainingPlan(planId) {
    return this.request(`${TRAINING_PLANS_ENDPOINT}/${planId}`);
  }
  async getAdaptiveTrainingPlan(planId) {
    return this.request(`${ADAPTIVE_TRAINING_PLAN_ENDPOINT}/${planId}`);
  }
  async getScheduledWorkout(workoutId) {
    return this.request(`${SCHEDULED_WORKOUT_ENDPOINT}/${workoutId}`);
  }
  async getMenstrualCalendar(startDate, endDate) {
    return this.request(`${MENSTRUAL_CALENDAR_ENDPOINT}?startDate=${startDate}&endDate=${endDate}`);
  }
  async getMenstrualDataForDate(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${MENSTRUAL_DAYVIEW_ENDPOINT}/${resolvedDate}`);
  }
  async getPregnancySummary() {
    return this.request(PREGNANCY_SNAPSHOT_ENDPOINT);
  }
  async getLifestyleLoggingData(date) {
    const resolvedDate = date ?? todayString();
    return this.request(`${LIFESTYLE_LOGGING_ENDPOINT}/${resolvedDate}`);
  }
  async getAvailableBadges() {
    return this.request(AVAILABLE_BADGES_ENDPOINT);
  }
  async getAdhocChallenges() {
    return this.request(ADHOC_CHALLENGES_ENDPOINT);
  }
  async getBadgeChallenges() {
    return this.request(BADGE_CHALLENGES_ENDPOINT);
  }
  async getAvailableBadgeChallenges() {
    return this.request(AVAILABLE_BADGE_CHALLENGES_ENDPOINT);
  }
  async getNonCompletedBadgeChallenges() {
    return this.request(NON_COMPLETED_BADGE_CHALLENGES_ENDPOINT);
  }
  async getInProgressVirtualChallenges() {
    return this.request(INPROGRESS_VIRTUAL_CHALLENGES_ENDPOINT);
  }
  async getGearActivities(gearUuid, start = 0, limit = DEFAULT_GEAR_ACTIVITIES_LIMIT) {
    return this.request(`${GEAR_ACTIVITIES_ENDPOINT}/${gearUuid}/gear?start=${start}&limit=${limit}`);
  }
  async getGearDefaults() {
    return this.request(`${GEAR_DEFAULTS_ENDPOINT}/${this.userProfilePk}/activityTypes`);
  }
  async getSleepDataRange(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getSleepData(d));
  }
  async getHRVRange(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getHRV(d));
  }
  async getStressRange(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getStress(d));
  }
  async getSpO2Range(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getSpO2(d));
  }
  async getRespirationRange(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getRespiration(d));
  }
  async getTrainingReadinessRange(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getTrainingReadiness(d));
  }
  async getVO2MaxRange(startDate, endDate) {
    return this.fetchRange(startDate, endDate, (d) => this.getVO2Max(d));
  }
  async getDailyHealthSnapshot(date) {
    const resolvedDate = date ?? todayString();
    const requests = [
      ["summary", () => this.getDailySummary(resolvedDate)],
      ["heartRate", () => this.getHeartRate(resolvedDate)],
      ["stress", () => this.getStress(resolvedDate)],
      ["bodyBattery", () => this.getBodyBattery(resolvedDate, resolvedDate)],
      ["sleep", () => this.getSleepData(resolvedDate)],
      ["hrv", () => this.getHRV(resolvedDate)],
      ["respiration", () => this.getRespiration(resolvedDate)],
      ["spo2", () => this.getSpO2(resolvedDate)],
      ["steps", () => this.getStepsChart(resolvedDate)],
      ["floors", () => this.getFloors(resolvedDate)],
      ["intensityMinutes", () => this.getIntensityMinutes(resolvedDate)]
    ];
    const entries = await mapWithConcurrency(requests, DAILY_SNAPSHOT_CONCURRENCY, async ([key, request]) => {
      try {
        return [key, await request()];
      } catch {
        return [key, null];
      }
    });
    return { date: resolvedDate, ...Object.fromEntries(entries) };
  }
  async setActivityName(activityId, name) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}`, {
      method: "PUT",
      body: { activityName: name }
    });
  }
  async createManualActivity(payload) {
    return this.request(`${ACTIVITY_ENDPOINT}/manual`, {
      method: "POST",
      body: payload
    });
  }
  async deleteActivity(activityId) {
    return this.request(`${ACTIVITY_ENDPOINT}/${activityId}`, {
      method: "DELETE"
    });
  }
  async addWeighIn(weight, unitKey = "kg", date) {
    const resolvedDate = date ?? todayString();
    return this.request(ADD_WEIGH_IN_ENDPOINT, {
      method: "POST",
      body: {
        dateTimestamp: `${resolvedDate}T00:00:00.0`,
        gmtTimestamp: `${resolvedDate}T00:00:00.0`,
        unitKey,
        value: weight
      }
    });
  }
  async setHydration(valueMl, date) {
    const resolvedDate = date ?? todayString();
    return this.request(SET_HYDRATION_ENDPOINT, {
      method: "PUT",
      body: {
        calendarDate: resolvedDate,
        valueInML: valueMl,
        timestampLocal: `${resolvedDate}T00:00:00.0`
      }
    });
  }
  async setBloodPressure(systolic, diastolic, pulse, timestamp, notes) {
    const ts = timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
    return this.request(SET_BLOOD_PRESSURE_ENDPOINT, {
      method: "POST",
      body: {
        systolic,
        diastolic,
        pulse,
        measurementTimestampGMT: ts,
        notes: notes ?? null,
        sourceType: "manual"
      }
    });
  }
  async addGearToActivity(gearUuid, activityId) {
    return this.request(
      `${GEAR_LINK_ENDPOINT}/${gearUuid}/activity/${activityId}`,
      { method: "PUT" }
    );
  }
  async removeGearFromActivity(gearUuid, activityId) {
    return this.request(
      `${GEAR_UNLINK_ENDPOINT}/${gearUuid}/activity/${activityId}`,
      { method: "PUT" }
    );
  }
};

export {
  GarminAuth,
  DEFAULT_ACTIVITIES_LIMIT,
  GarminClient
};
