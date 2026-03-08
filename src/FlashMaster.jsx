// ╔══════════════════════════════════════════════════════════════════════╗
// ║  FLASHMASTER v6.0.0                                                    ║
// ║  Mandatory Google Login · Continuous Drive Sync                      ║
// ╠══════════════════════════════════════════════════════════════════════╣
// ║  ✦ Real Dexie.js from CDN with proper indexes                       ║
// ║  ✦ Schema versioning (v1→v2→v3 migrations)                          ║
// ║  ✦ reviewHistory table for accurate analytics                        ║
// ║  ✦ SM-2 with easeFactor / interval / reviewCount / nextReviewDate    ║
// ║  ✦ Review Queue: New → Learning → Review → Due → Mastered           ║
// ║  ✦ CSV import with parse → validate → preview → import              ║
// ║  ✦ Dynamic QuestionRenderer per type (MCQ/Match/Order/Cloze/…)      ║
// ║  ✦ Full session resume (index, timer, state)                         ║
// ║  ✦ Export / Import JSON backup                                       ║
// ║  ✦ Virtualized list for large datasets                               ║
// ║  ✦ WebKit Speech fallback · AES-GCM encryption                      ║
// ║  ✦ Google OAuth 2.0 — mandatory first screen                        ║
// ║  ✦ Auto Drive sync on every data change (debounced 4s)              ║
// ║  ✦ Post-login: Drive pull → Profiles screen                         ║
// ║  ✦ Sync status indicator in sidebar                                 ║
// ╚══════════════════════════════════════════════════════════════════════╝

import {
  useState, useEffect, useContext, createContext,
  useRef, useCallback, useMemo, useReducer, Suspense,
} from "react";
import JSZip from "jszip";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, AreaChart, Area, Cell,
} from "recharts";

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
const DOCUMENTATION_URL = `${import.meta.env.BASE_URL}documentation/index.html`;

// ══════════════════════════════════════════════════════════════
// §1  DEXIE LOADER  — loads real Dexie.js from CDN at runtime
// ══════════════════════════════════════════════════════════════
let _dexieReady = null;
async function loadDexie() {
  if (window.Dexie) return window.Dexie;
  if (_dexieReady) return _dexieReady;
  _dexieReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/dexie/3.2.4/dexie.min.js";
    s.onload = () => resolve(window.Dexie);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _dexieReady;
}

// ══════════════════════════════════════════════════════════════
// §1b  GOOGLE SERVICES LOADER  (GIS + Drive REST)
// ══════════════════════════════════════════════════════════════
let _gisReady = null;
async function loadGIS() {
  if (window.google?.accounts) return window.google.accounts;
  if (_gisReady) return _gisReady;
  _gisReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload  = () => resolve(window.google.accounts);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _gisReady;
}

// ══════════════════════════════════════════════════════════════
// §1c  GOOGLE DRIVE ENGINE
// ══════════════════════════════════════════════════════════════
const GDrive = {
  _accessToken    : null,
  _tokenExpiry    : 0,
  _tokenClient    : null,     // single GIS client per clientId (never recreated)
  _tokenClientId  : null,
  _tokenResolvers : [],       // dispatch queue: all concurrent waiters for a token
  _pendingToken   : null,     // shared in-flight promise (deduplicates ALL callers)
  FOLDER_NAME  : "FlashMaster",
  SCOPES       : [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),

  // ── Token management ───────────────────────────────────────
  async requestToken(clientId, interactive = true) {
    // Return cached token if still valid (60-second buffer)
    if (this._accessToken && Date.now() < this._tokenExpiry - 60_000) {
      return this._accessToken;
    }

    // Deduplicate: ALL concurrent callers share one in-flight promise.
    // This prevents multiple GIS popup windows and hanging promises from
    // concurrent requestAccessToken calls stomping each other's callbacks.
    if (this._pendingToken) return this._pendingToken;

    const accounts = await loadGIS();

    // Create the GIS tokenClient ONCE per clientId.
    // GIS's token client uses a persistent dispatch callback; every
    // requestAccessToken call fires that same callback.  We route responses
    // to the correct per-call resolver via a resolver queue.
    if (!this._tokenClient || this._tokenClientId !== clientId) {
      this._tokenResolvers = [];
      this._tokenClient = accounts.oauth2.initTokenClient({
        client_id : clientId,
        scope     : this.SCOPES,
        callback  : resp => {
          // Drain the queue — one entry per requestAccessToken call
          const pending = this._tokenResolvers.splice(0, 1)[0];
          if (!pending) return;
          if (resp.error) { pending.reject(new Error(resp.error)); return; }
          this._accessToken = resp.access_token;
          this._tokenExpiry = Date.now() + resp.expires_in * 1000;
          pending.resolve(resp.access_token);
        },
      });
      this._tokenClientId = clientId;
    }

    const doRequest = (prompt) => new Promise((resolve, reject) => {
      this._tokenResolvers.push({ resolve, reject });
      this._tokenClient.requestAccessToken({ prompt });
    });

    this._pendingToken = (async () => {
      try {
        if (!interactive) {
          // Silent only — never shows a popup
          return await doRequest("none");
        }
        // Two-stage interactive:
        //  1. Try prompt:"none" first — succeeds silently when the browser
        //     still holds a valid Google session (very common case).
        //  2. Fall back to prompt:"select_account" — reliably shows the
        //     account picker.  Avoids the loop caused by prompt:"" when
        //     FedCM/third-party cookies are blocked (Safari/Firefox ETP).
        try {
          return await doRequest("none");
        } catch {
          return await doRequest("select_account");
        }
      } finally {
        this._pendingToken = null;
      }
    })();

    return this._pendingToken;
  },

  revokeToken() {
    if (this._accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(this._accessToken, () => {});
    }
    this._accessToken  = null;
    this._tokenExpiry  = 0;
    this._pendingToken = null;
    this._tokenResolvers = [];
    // Keep _tokenClient cached — revoke doesn't invalidate the client itself
  },

  /** Returns true only when we already hold a non-expired access token.
   *  Does NOT attempt a silent refresh.  Use this to gate background ops
   *  so we never create spurious GIS token-client instances that cause
   *  the consent popup to appear unexpectedly. */
  hasValidToken() {
    return !!(this._accessToken && Date.now() < this._tokenExpiry - 60_000);
  },

  // ── Drive REST helpers ─────────────────────────────────────
  async _driveGet(path, token) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Drive GET ${path}: ${r.status}`);
    return r.json();
  },

  async _drivePost(path, token, body) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
      method  : "POST",
      headers : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body    : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Drive POST ${path}: ${r.status}`);
    return r.json();
  },

  async _drivePatch(path, token, body) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/${path}`, {
      method  : "PATCH",
      headers : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body    : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Drive PATCH: ${r.status}`);
    return r.json();
  },

  async _driveDelete(path, token) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok && r.status !== 404) throw new Error(`Drive DELETE ${path}: ${r.status}`);
    return true;
  },

  // ── User info ──────────────────────────────────────────────
  async getUserInfo(token) {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error("getUserInfo: " + r.status);
    return r.json();
  },

  // ── Folder management ──────────────────────────────────────
  async findOrCreateFolder(token) {
    const q = encodeURIComponent(
      `name='${this.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`
    );
    const res = await this._driveGet(`files?q=${q}&fields=files(id,name)`, token);
    if (res.files?.length) return res.files[0].id;

    const folder = await this._drivePost("files", token, {
      name     : this.FOLDER_NAME,
      mimeType : "application/vnd.google-apps.folder",
      parents  : ["root"],
    });
    return folder.id;
  },

  // ── File helpers ───────────────────────────────────────────
  async findFile(token, folderId, filename) {
    const q = encodeURIComponent(
      `name='${filename}' and '${folderId}' in parents and trashed=false`
    );
    const res = await this._driveGet(`files?q=${q}&fields=files(id,name,modifiedTime)`, token);
    return res.files?.[0] || null;
  },

  // ── Resumable upload for large files (>4 MB) ──────────────
  async _resumableUpload(token, folderId, filename, content, existingId = null) {
    const initiateUrl = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=resumable`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id";
    const metadataBody = existingId ? {} : { name: filename, parents: [folderId] };
    const initResp = await fetch(initiateUrl, {
      method  : existingId ? "PATCH" : "POST",
      headers : {
        Authorization              : `Bearer ${token}`,
        "Content-Type"             : "application/json; charset=UTF-8",
        "X-Upload-Content-Type"    : "application/json",
        "X-Upload-Content-Length"  : String(new Blob([content]).size),
      },
      body: JSON.stringify(metadataBody),
    });
    if (!initResp.ok) throw new Error(`Resumable initiate: ${initResp.status}`);
    const uploadUrl = initResp.headers.get("Location");
    if (!uploadUrl) throw new Error("No upload URL from Drive resumable initiate");
    const upResp = await fetch(uploadUrl, {
      method  : "PUT",
      headers : { "Content-Type": "application/json" },
      body    : content,
    });
    if (!upResp.ok) throw new Error(`Resumable PUT: ${upResp.status}`);
    const result = await upResp.json().catch(() => ({ id: existingId }));
    return result.id || existingId;
  },

  async uploadFile(token, folderId, filename, data) {
    // Compact JSON — no indentation. Removes ~20-30 % of size versus null,2.
    const content  = JSON.stringify(data);
    const isLarge  = content.length > 4_000_000; // >4 MB → use resumable upload
    const existing = await this.findFile(token, folderId, filename);

    if (existing) {
      if (isLarge) return this._resumableUpload(token, folderId, filename, content, existing.id);
      // Simple media PATCH for small files
      const r = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
        {
          method  : "PATCH",
          headers : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body    : content,
        }
      );
      if (!r.ok) throw new Error("uploadFile PATCH: " + r.status);
      return existing.id;
    }

    if (isLarge) return this._resumableUpload(token, folderId, filename, content, null);

    // Multipart upload (metadata + media) for new small files
    const meta     = JSON.stringify({ name: filename, parents: [folderId] });
    const boundary = "fmboundary" + Date.now();
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      meta,
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      content,
      `--${boundary}--`,
    ].join("\r\n");

    const r = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method  : "POST",
        headers : {
          Authorization  : `Bearer ${token}`,
          "Content-Type" : `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    if (!r.ok) throw new Error("uploadFile POST: " + r.status);
    const result = await r.json();
    return result.id;
  },

  async downloadFile(token, fileId) {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error("downloadFile: " + r.status);
    return r.json();
  },

  async listProfileFiles(token, folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const res = await this._driveGet(`files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=name`, token);
    return (res.files || []).filter(f => /^profile_[^_].*\.json$/i.test(f.name));
  },

  async readJsonFile(clientId, filename) {
    const token = await this.requestToken(clientId, false);
    const folderId = await this.findOrCreateFolder(token);
    const file = await this.findFile(token, folderId, filename);
    if (!file) return null;
    return { file, data: await this.downloadFile(token, file.id) };
  },

  async writeJsonFile(clientId, filename, data) {
    const token = await this.requestToken(clientId, false);
    const folderId = await this.findOrCreateFolder(token);
    await this.uploadFile(token, folderId, filename, data);
    return filename;
  },

  async deleteJsonFile(clientId, filename) {
    const token = await this.requestToken(clientId, false);
    const folderId = await this.findOrCreateFolder(token);
    const file = await this.findFile(token, folderId, filename);
    if (!file) return false;
    await this._driveDelete(`files/${file.id}`, token);
    return true;
  },

  // ── High-level sync ops ────────────────────────────────────
  /** Push a single profile + all its data to Drive */
  async syncProfileUp(clientId, profileId, exportData) {
    const token    = await this.requestToken(clientId, false);
    const folderId = await this.findOrCreateFolder(token);
    const filename = `profile_${profileId}.json`;
    await this.uploadFile(token, folderId, filename, exportData);
    return filename;
  },

  /** Pull all profile files from Drive, return parsed array */
  async syncAllDown(clientId) {
    const token    = await this.requestToken(clientId, false);
    const folderId = await this.findOrCreateFolder(token);
    const files    = await this.listProfileFiles(token, folderId);
    const results  = await Promise.all(
      files.map(f => this.downloadFile(token, f.id).then(d => ({ file: f, data: d })).catch(() => null))
    );
    return results.filter(Boolean);
  },

  async getProfileLock(clientId, profileId) {
    return (await this.readJsonFile(clientId, `profile_lock_${profileId}.json`))?.data || null;
  },

  async putProfileLock(clientId, profileId, lockData) {
    await this.writeJsonFile(clientId, `profile_lock_${profileId}.json`, lockData);
    return profileId;
  },

  async deleteProfileLock(clientId, profileId) {
    return this.deleteJsonFile(clientId, `profile_lock_${profileId}.json`);
  },

  async listProfileLocks(clientId) {
    const token = await this.requestToken(clientId, false);
    const folderId = await this.findOrCreateFolder(token);
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const res = await this._driveGet(`files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=name`, token);
    const files = (res.files || []).filter(file => /^profile_lock_.*\.json$/i.test(file.name));
    const results = await Promise.all(
      files.map(file => this.downloadFile(token, file.id).then(data => ({ file, data })).catch(() => null))
    );
    return results.filter(Boolean);
  },
};

// ══════════════════════════════════════════════════════════════
// §2  DB ENGINE  — Dexie schema with indexes + migrations
// ══════════════════════════════════════════════════════════════
let _db = null;

async function getDB() {
  if (_db) return _db;
  const Dexie = await loadDexie();
  const db = new Dexie("FlashMasterV4");

  // Version 1 — base schema
  db.version(1).stores({
    profiles:      "id, name",
    subjects:      "id, uid, name",
    topics:        "id, sid, name",
    subtopics:     "id, tid, name",
    questions:     "id, stid, type, difficulty",
    flashProgress: "id, uid, qid, nextReview, status, box",
    quizAttempts:  "id, uid, tid, stid, attempt_date",
    studySessions: "id, uid, date",
    leaderboard:   "id, uid",
  });

  // Version 2 — add reviewHistory + audioCache
  db.version(2).stores({
    profiles:      "id, name",
    subjects:      "id, uid, name",
    topics:        "id, sid, name",
    subtopics:     "id, tid, name",
    questions:     "id, stid, type, difficulty",
    flashProgress: "id, uid, qid, nextReview, status, box",
    quizAttempts:  "id, uid, tid, stid, attempt_date",
    studySessions: "id, uid, date",
    leaderboard:   "id, uid",
    reviewHistory: "id, uid, qid, timestamp, grade",
    audioCache:    "id, url",
  });

  // Version 3 — add sessionDraft + compound index on flashProgress
  db.version(3).stores({
    profiles:      "id, name",
    subjects:      "id, uid, name",
    topics:        "id, sid, name",
    subtopics:     "id, tid, name",
    questions:     "id, stid, type, difficulty",
    flashProgress: "id, [uid+qid], uid, qid, nextReview, status, box",
    quizAttempts:  "id, uid, tid, stid, attempt_date",
    studySessions: "id, uid, date",
    leaderboard:   "id, uid",
    reviewHistory: "id, uid, qid, timestamp, grade",
    audioCache:    "id, url",
    sessionDraft:  "id, uid",
  }).upgrade(trans => {
    // Migration: add compound key to existing flashProgress records
    return trans.flashProgress.toCollection().modify(fp => {
      if (!fp.uid || !fp.qid) return;
    });
  });

  await db.open();
  _db = db;

  // Migrate from localStorage (v3/older builds)
  await migrateFromLocalStorage(db);
  return db;
}

async function migrateFromLocalStorage(db) {
  const lsKeys = [
    ["fm4_profiles","profiles"], ["fm3_profiles","profiles"],
    ["fm4_subjects","subjects"], ["fm3_subjects","subjects"],
    ["fm4_topics","topics"],     ["fm3_topics","topics"],
    ["fm4_subtopics","subtopics"],["fm3_subtopics","subtopics"],
    ["fm4_questions","questions"],["fm3_questions","questions"],
    ["fm4_flashProg","flashProgress"],["fm3_flashProg","flashProgress"],
    ["fm4_quizAttempts","quizAttempts"],
    ["fm4_sessions","studySessions"],
  ];
  for (const [lsKey, table] of lsKeys) {
    try {
      const raw = localStorage.getItem(lsKey);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) continue;
      const count = await db[table].count();
      if (count > 0) continue; // don't overwrite
      await db[table].bulkPut(arr);
      console.log(`[FM4] Migrated ${arr.length} records: ${lsKey} → ${table}`);
    } catch { /* ignore */ }
  }
}

// DB query helpers (typed, indexed)
const DB = {
  async profiles()            { const db = await getDB(); return db.profiles.toArray(); },
  async profileById(id)       { const db = await getDB(); return db.profiles.get(id); },
  async putProfile(p)         { const db = await getDB(); return db.profiles.put(p); },
  async deleteProfile(id)     { const db = await getDB(); return db.profiles.delete(id); },

  async subjectsByUser(uid)   { const db = await getDB(); return db.subjects.where("uid").equals(uid).toArray(); },
  async putSubject(s)         { const db = await getDB(); return db.subjects.put(s); },
  async deleteSubject(id)     { const db = await getDB(); return db.subjects.delete(id); },
  async bulkDeleteSubjects(ids){ const db = await getDB(); return db.subjects.bulkDelete(ids); },

  async topicsBySid(sid)      { const db = await getDB(); return db.topics.where("sid").equals(sid).toArray(); },
  async putTopic(t)           { const db = await getDB(); return db.topics.put(t); },
  async deleteTopic(id)       { const db = await getDB(); return db.topics.delete(id); },
  async topicsByIds(ids)      { const db = await getDB(); return db.topics.where("id").anyOf(ids).toArray(); },

  async subtopicsByTid(tid)   { const db = await getDB(); return db.subtopics.where("tid").equals(tid).toArray(); },
  async subtopicsByTids(tids) { const db = await getDB(); return db.subtopics.where("tid").anyOf(tids).toArray(); },
  async putSubtopic(s)        { const db = await getDB(); return db.subtopics.put(s); },
  async bulkPutSubtopics(arr) { const db = await getDB(); return db.subtopics.bulkPut(arr); },
  async deleteSubtopic(id)    { const db = await getDB(); return db.subtopics.delete(id); },

  async questionsByStid(stid) { const db = await getDB(); return db.questions.where("stid").equals(stid).toArray(); },
  async questionsByStids(ids) { const db = await getDB(); return db.questions.where("stid").anyOf(ids).toArray(); },
  async allQuestions()        { const db = await getDB(); return db.questions.toArray(); },
  async putQuestion(q)        { const db = await getDB(); return db.questions.put(q); },
  async bulkPutQuestions(arr) { const db = await getDB(); return db.questions.bulkPut(arr); },
  async deleteQuestion(id)    { const db = await getDB(); return db.questions.delete(id); },
  async countQuestions()      { const db = await getDB(); return db.questions.count(); },

  // flashProgress — uses compound [uid+qid] index for O(1) lookup
  async progressByUser(uid)   { const db = await getDB(); return db.flashProgress.where("uid").equals(uid).toArray(); },
  async progressDue(uid)      { const db = await getDB(); return db.flashProgress.where("uid").equals(uid).filter(f => SRS.isDue(f) && f.status !== "mastered").toArray(); },
  async putProgress(p)        { const db = await getDB(); return db.flashProgress.put(p); },
  async bulkPutProgress(arr)  { const db = await getDB(); return db.flashProgress.bulkPut(arr); },
  async deleteProgress(id)    { const db = await getDB(); return db.flashProgress.delete(id); },
  async deleteProgressByQids(uid, qids) {
    const db = await getDB();
    const toDelete = await db.flashProgress.where("uid").equals(uid).filter(f => qids.has(f.qid)).primaryKeys();
    return db.flashProgress.bulkDelete(toDelete);
  },

  // reviewHistory — critical for analytics
  async addReview(r)          { const db = await getDB(); return db.reviewHistory.put(r); },
  async reviewsByUser(uid)    { const db = await getDB(); return db.reviewHistory.where("uid").equals(uid).toArray(); },
  async reviewsByQid(uid, qid){ const db = await getDB(); return db.reviewHistory.where("uid").equals(uid).filter(r => r.qid === qid).toArray(); },
  async reviewsAfter(uid, ts) { const db = await getDB(); return db.reviewHistory.where("uid").equals(uid).filter(r => r.timestamp > ts).toArray(); },

  async putQuizAttempt(a)     { const db = await getDB(); return db.quizAttempts.put(a); },
  async quizAttemptsByUser(uid){ const db = await getDB(); return db.quizAttempts.where("uid").equals(uid).toArray(); },

  async putSession(s)         { const db = await getDB(); return db.studySessions.put(s); },

  async putLeaderboard(l)     { const db = await getDB(); return db.leaderboard.put(l); },
  async allLeaderboard()      { const db = await getDB(); return db.leaderboard.toArray(); },

  async getSessionDraft(uid)  { const db = await getDB(); return db.sessionDraft.get(uid); },
  async putSessionDraft(d)    { const db = await getDB(); return db.sessionDraft.put(d); },
  async clearSessionDraft(uid){ const db = await getDB(); return db.sessionDraft.delete(uid); },

  // Full export for backup
  async exportAll() {
    const db = await getDB();
    const [profiles, subjects, topics, subtopics, questions,
           flashProgress, quizAttempts, studySessions, leaderboard, reviewHistory] = await Promise.all([
      db.profiles.toArray(), db.subjects.toArray(), db.topics.toArray(),
      db.subtopics.toArray(), db.questions.toArray(), db.flashProgress.toArray(),
      db.quizAttempts.toArray(), db.studySessions.toArray(), db.leaderboard.toArray(),
      db.reviewHistory.toArray(),
    ]);
    return { version:4, exported: new Date().toISOString(), profiles, subjects, topics, subtopics,
             questions, flashProgress, quizAttempts, studySessions, leaderboard, reviewHistory };
  },

  async importAll(data) {
    const db = await getDB();
    await Promise.all([
      db.profiles.bulkPut(data.profiles || []),
      db.subjects.bulkPut(data.subjects || []),
      db.topics.bulkPut(data.topics || []),
      db.subtopics.bulkPut(data.subtopics || []),
      db.questions.bulkPut(data.questions || []),
      db.flashProgress.bulkPut(data.flashProgress || []),
      db.quizAttempts.bulkPut(data.quizAttempts || []),
      db.studySessions.bulkPut(data.studySessions || []),
      db.leaderboard.bulkPut(data.leaderboard || []),
      db.reviewHistory.bulkPut(data.reviewHistory || []),
    ]);
  },

  async clearUserData(uid) {
    const db = await getDB();
    const sids = (await db.subjects.where("uid").equals(uid).primaryKeys());
    const tids = (await db.topics.where("sid").anyOf(sids).primaryKeys());
    const stids = (await db.subtopics.where("tid").anyOf(tids).primaryKeys());
    await Promise.all([
      db.subjects.where("uid").equals(uid).delete(),
      db.topics.where("sid").anyOf(sids).delete(),
      db.subtopics.where("tid").anyOf(tids).delete(),
      db.questions.where("stid").anyOf(stids).delete(),
      db.flashProgress.where("uid").equals(uid).delete(),
      db.quizAttempts.where("uid").equals(uid).delete(),
      db.studySessions.where("uid").equals(uid).delete(),
      db.reviewHistory.where("uid").equals(uid).delete(),
      db.sessionDraft.delete(uid),
    ]);
  },
};

// ══════════════════════════════════════════════════════════════
// §3  SM-2 ENGINE  — Full algorithm with all required fields
// ══════════════════════════════════════════════════════════════
function buildProfileSyncData(data, profileId) {
  const subjects = data.subjects.filter(subject => subject.uid === profileId);
  const subjectIds = new Set(subjects.map(subject => subject.id));
  const topics = data.topics.filter(topic => subjectIds.has(topic.sid));
  const topicIds = new Set(topics.map(topic => topic.id));
  const subtopics = data.subtopics.filter(subtopic => topicIds.has(subtopic.tid));
  const subtopicIds = new Set(subtopics.map(subtopic => subtopic.id));

  return {
    version: 6,
    syncedAt: new Date().toISOString(),
    syncVersion: "v6.0",
    profiles: data.profiles.filter(profile => profile.id === profileId),
    subjects,
    topics,
    subtopics,
    questions: data.questions.filter(question => subtopicIds.has(question.stid)),
    flashProgress: data.flashProgress.filter(progress => progress.uid === profileId),
    quizAttempts: data.quizAttempts.filter(attempt => attempt.uid === profileId),
    studySessions: data.studySessions ? data.studySessions.filter(session => session.uid === profileId) : [],
    reviewHistory: data.reviewHistory.filter(review => review.uid === profileId),
  };
}

async function replaceProfileSnapshots(data) {
  const profileIds = (data?.profiles || []).map(profile => profile?.id).filter(Boolean);
  if (!profileIds.length) return;

  for (const profileId of profileIds) {
    await DB.clearUserData(profileId);
    await DB.deleteProfile(profileId);
  }
  await DB.importAll(data);
}

const SRS = {
  // Maps user-facing rating → SM-2 quality score (0–5)
  QUALITY: { again: 0, hard: 2, good: 4, easy: 5 },

  // Queue states matching Anki's model
  QUEUE: { NEW: "new", LEARNING: "learning", REVIEW: "review", DUE: "due", MASTERED: "mastered" },

  /**
   * Apply SM-2 algorithm.
   * Accepts existing progress object + rating string.
   * Returns merged progress with all required SRS fields.
   */
  apply(prev, rating) {
    const q = this.QUALITY[rating] ?? 3;
    let {
      easeFactor   = 2.5,
      interval     = 0,
      reviewCount  = 0,
      box          = 0,
    } = prev || {};

    let newStatus;
    if (q < 3) {
      // Failed — reset to learning
      reviewCount = 0;
      interval    = 1;
      box         = Math.max(0, box - 1);
      newStatus   = box === 0 ? this.QUEUE.LEARNING : this.QUEUE.REVIEW;
    } else {
      // Passed
      if (reviewCount === 0)      interval = 1;
      else if (reviewCount === 1) interval = 6;
      else                        interval = Math.round(interval * easeFactor);
      reviewCount++;
      box = Math.min(box + 1, 6);
      newStatus = box >= 6 ? this.QUEUE.MASTERED : box >= 2 ? this.QUEUE.REVIEW : this.QUEUE.LEARNING;
    }

    // SM-2 ease factor adjustment
    easeFactor = Math.max(1.3,
      easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)
    );

    const nextReviewDate = new Date();
    nextReviewDate.setDate(nextReviewDate.getDate() + interval);

    return {
      ...prev,
      easeFactor:     Math.round(easeFactor * 1000) / 1000,
      interval,
      reviewCount,
      nextReviewDate: nextReviewDate.toISOString(),
      nextReview:     nextReviewDate.toISOString(), // alias for index
      lastReview:     new Date().toISOString(),
      box,
      status:         newStatus,
      correct:        q >= 3,
      totalShown:     (prev?.totalShown || 0) + 1,
      correctCount:   (prev?.correctCount || 0) + (q >= 3 ? 1 : 0),
    };
  },

  isDue(prog) {
    if (!prog) return true;
    if (prog.status === this.QUEUE.MASTERED) return false;
    if (prog.status === this.QUEUE.NEW || !prog.nextReviewDate) return true;
    return new Date() >= new Date(prog.nextReviewDate);
  },

  queueLabel(prog) {
    if (!prog || prog.status === this.QUEUE.NEW || !prog.reviewCount) return "New";
    if (prog.status === this.QUEUE.MASTERED) return "Mastered";
    if (this.isDue(prog)) return "Due";
    if (prog.status === this.QUEUE.LEARNING) return "Learning";
    return "Review";
  },

  /** Ebbinghaus retrievability: R = e^(-Δt/S) */
  retention(prog) {
    if (!prog?.lastReview) return 0;
    const daysSince = (Date.now() - new Date(prog.lastReview)) / 86_400_000;
    const S = prog.interval || 1;
    return Math.round(Math.exp(-daysSince / S) * 100);
  },

  /** Priority sort for smart deck: Due first, then weak, then new */
  prioritize(questions, progMap) {
    const score = q => {
      const p = progMap.get(q.id);
      if (!p || !p.reviewCount)               return 0; // new → highest priority
      if (this.isDue(p))                       return 1; // due
      const acc = p.totalShown > 0 ? p.correctCount / p.totalShown : 0;
      if (acc < 0.5)                           return 2; // weak
      return 3;                                          // later
    };
    const shuffled = [...questions].sort(() => Math.random() - 0.5);
    return shuffled.sort((a, b) => score(a) - score(b));
  },
};

// ══════════════════════════════════════════════════════════════
// §4  REVIEW QUEUE ENGINE
// ══════════════════════════════════════════════════════════════
class ReviewQueue {
  /**
   * Builds a prioritized deck from questions + progress map.
   * Returns { newCards, dueCards, reviewCards, masteredCards, deck }
   */
  static build(questions, progMap, limit = 50) {
    const buckets = { new: [], due: [], learning: [], review: [], mastered: [] };
    for (const q of questions) {
      const p = progMap.get(q.id);
      if (!p || !p.reviewCount) {
        buckets.new.push(q);
      } else if (p.status === SRS.QUEUE.MASTERED) {
        buckets.mastered.push(q);
      } else if (SRS.isDue(p)) {
        buckets.due.push(q);
      } else if (p.status === SRS.QUEUE.LEARNING) {
        buckets.learning.push(q);
      } else {
        buckets.review.push(q);
      }
    }
    // Priority: due > learning > new > review (mastered excluded unless forced)
    const deck = [
      ...shuffle(buckets.due),
      ...shuffle(buckets.learning),
      ...shuffle(buckets.new),
      ...shuffle(buckets.review),
    ].slice(0, limit);

    return {
      newCount:      buckets.new.length,
      dueCount:      buckets.due.length,
      learningCount: buckets.learning.length,
      reviewCount:   buckets.review.length,
      masteredCount: buckets.mastered.length,
      total:         questions.length,
      deck,
    };
  }
}

// ══════════════════════════════════════════════════════════════
// §5  CSV ENGINE  — parse → validate → preview → import
// ══════════════════════════════════════════════════════════════
const VALID_TYPES = ["Text","Image","MCQ","FillBlank","TrueFalse","Match","Order","Dictation","MultiSelect","Cloze","Audio"];
const VALID_DIFF  = ["easy","medium","hard"];
const VALID_TYPE_KEYS = new Set(VALID_TYPES.map(type => type.toLowerCase()));
const VALID_TYPE_MAP = new Map(VALID_TYPES.map(type => [type.toLowerCase(), type]));
const OPTION_REQUIRED_TYPES = new Set(["mcq","multiselect","match"]);
const ZIP_IMAGE_FILE_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const AUDIO_FILE_RE = /\.(aac|flac|m4a|mp3|oga|ogg|wav|webm)(?:[?#].*)?$/i;
const IMAGE_FILE_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
const IMPORT_MODE_META = {
  csv: {
    label: "CSV + Media URLs",
    accept: ".csv,.txt,text/csv,text/plain",
    prompt: "Drop CSV or click to browse",
    helper: "Type is optional. Image rows must include a media or media_url value.",
  },
  zip: {
    label: "ZIP Images",
    accept: ".zip,application/zip,application/x-zip-compressed",
    prompt: "Drop ZIP or click to browse",
    helper: "Each image becomes a question. The filename becomes the answer.",
  },
};

function detectImportMode(file) {
  if (!file) return "";
  if (/\.zip$/i.test(file.name) || /zip/i.test(file.type || "")) return "zip";
  if (/\.(csv|txt)$/i.test(file.name) || /(csv|plain)/i.test(file.type || "")) return "csv";
  return "";
}

function splitOptionValues(options = "") {
  return String(options || "").split(",").map(value => value.trim()).filter(Boolean);
}

function normalizeMediaUrl(media = "") {
  const raw = String(media || "").trim();
  if (!raw || /^data:|^blob:/i.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    if (host.includes("drive.google.com")) {
      const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/i);
      const fileId = fileMatch?.[1] || url.searchParams.get("id");
      if (fileId) return `https://drive.google.com/uc?export=view&id=${fileId}`;
    }

    if (host === "dropbox.com" || host === "www.dropbox.com") {
      url.searchParams.delete("dl");
      url.searchParams.set("raw", "1");
      return url.toString();
    }
  } catch {
    return raw;
  }

  return raw;
}

function detectMediaKind(media = "") {
  const value = normalizeMediaUrl(media).toLowerCase();
  if (!value) return "";
  if (value.startsWith("data:image/")) return "image";
  if (value.startsWith("data:audio/")) return "audio";
  if (IMAGE_FILE_RE.test(value)) return "image";
  if (AUDIO_FILE_RE.test(value)) return "audio";
  if (/^https?:\/\//.test(value) || value.startsWith("/")) return "image";
  return "";
}

function inferQuestionType(question = {}) {
  const rawType = String(question?.type || "").trim().toLowerCase();
  const explicitType = VALID_TYPE_MAP.get(rawType) || "";
  if (explicitType && explicitType !== "Text") return explicitType;

  const mediaKind = detectMediaKind(question?.media);
  if (mediaKind === "image") return "Image";
  if (mediaKind === "audio") return "Audio";

  const prompt = String(question?.question_text || question?.question || "").trim();
  const promptLower = prompt.toLowerCase();
  const answer = String(question?.answer || "").trim();
  const answerParts = splitOptionValues(answer);
  const options = String(question?.options || "").trim();
  const optionValues = splitOptionValues(options);

  if (prompt.includes("___")) return "Cloze";
  if (/^(true|false)$/i.test(answer) && (!optionValues.length || optionValues.every(value => /^(true|false)$/i.test(value)))) return "TrueFalse";
  if (optionValues.some(value => value.includes(":"))) return "Match";
  if (/(arrange|order|sequence|sort)/i.test(promptLower) && (optionValues.length > 1 || answerParts.length > 1)) return "Order";
  if (optionValues.length >= 2) return answerParts.length > 1 ? "MultiSelect" : "MCQ";
  return explicitType || "Text";
}

function normalizeQuestionType(questionOrType, media = "") {
  if (typeof questionOrType === "string") return inferQuestionType({ type: questionOrType, media });
  return inferQuestionType(questionOrType);
}

function isImageQuestion(question) {
  return normalizeQuestionType(question) === "Image";
}

function formatAnswerTypeLabel(key) {
  const cleaned = String(key || "answer").replace(/^answer[-_]?/i, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "Answer";
  return cleaned.replace(/\b\w/g, ch => ch.toUpperCase());
}

function hashString(input = "") {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  return hash;
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image file"));
    reader.readAsDataURL(blob);
  });
}

function decodeZipLabel(value = "") {
  const source = String(value || "");
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

function labelFromZipSegment(value = "") {
  return decodeZipLabel(value)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CSV = {
  normalizeHeader(header = "") {
    return String(header)
      .replace(/^\uFEFF/, "")
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
      .replace(/_+/g, "_");
  },

  parseTable(text) {
    const source = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    const pushCell = () => {
      row.push(cell.trim());
      cell = "";
    };
    const pushRow = () => {
      if (!row.length) return;
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    };

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];

      if (ch === '"') {
        if (inQuotes && source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === "," && !inQuotes) {
        pushCell();
        continue;
      }
      if (ch === "\n" && !inQuotes) {
        pushCell();
        pushRow();
        continue;
      }
      cell += ch;
    }

    if (cell.length || row.length) {
      pushCell();
      pushRow();
    }

    return {
      rows,
      error: inQuotes ? "File contains an unclosed quoted field." : "",
    };
  },

  parseRow(line) {
    return this.parseTable(line).rows[0] || [];
  },

  /**
   * Full parse pipeline.
   * Returns { rows, errors, warnings, preview }
   */
  parse(text) {
    const { rows: table, error: parseError } = this.parseTable(text);
    if (parseError) return { rows: [], errors: [parseError], warnings: [], preview: [] };
    if (table.length < 2) return { rows: [], errors: ["File has no data rows"], warnings: [], preview: [] };

    const headers = table[0].map(h => this.normalizeHeader(h));
    const errors = [], warnings = [];

    const idx = name => headers.indexOf(name);
    const qCol = [idx("question_text"), idx("question"), idx("q")].find(i => i >= 0);
    const aCol = [idx("answer"), idx("a")].find(i => i >= 0);
    const mediaCol = [idx("media"), idx("media_url"), idx("mediaurl"), idx("image_url"), idx("imageurl")].find(i => i >= 0);
    const optionsCol = [idx("options"), idx("choices"), idx("items"), idx("pairs")].find(i => i >= 0);
    const answerTypeCols = headers.map((header, index) =>
      header.startsWith("answer_") ? { key: header.slice(7), index } : null
    ).filter(Boolean);

    if (qCol === undefined && mediaCol === undefined) return { rows: [], errors: ["Missing column: question_text, question, media, or media_url"], warnings: [], preview: [] };
    if (aCol === undefined && !answerTypeCols.length) return { rows: [], errors: ["Missing column: answer or answer-{answer-type}"], warnings: [], preview: [] };

    const rows = [], preview = [];

    table.slice(1).forEach((cols, li) => {
      if (!cols.some(value => String(value || "").trim())) return;
      const get = (i, fb = "") => (i !== undefined && i >= 0 ? cols[i] || "" : fb).trim();

      const rawType = get(idx("type"));
      const rawDiff = (get(idx("difficulty")) || get(idx("diff")) || "medium").toLowerCase();
      const media = normalizeMediaUrl(get(mediaCol));
      const options = get(optionsCol);
      const normalizedCsvType = String(rawType || "").trim().toLowerCase();
      const diff = VALID_DIFF.includes(rawDiff) ? rawDiff : "medium";
      const answerVariants = answerTypeCols
        .map(col => {
          const value = get(col.index);
          if (!value) return null;
          return {
            key: col.key,
            label: formatAnswerTypeLabel(col.key),
            value,
            isDefault: false,
          };
        })
        .filter(Boolean);
      const legacyAnswer = get(aCol);
      if (!answerVariants.length && legacyAnswer) {
        answerVariants.push({ key:"answer", label:"Answer", value:legacyAnswer, isDefault:true });
      }
      const inferredAnswer = answerVariants[0]?.value || legacyAnswer;
      const rawQuestionText = get(qCol);
      const type = normalizeQuestionType({
        type: rawType,
        media,
        options,
        question_text: rawQuestionText,
        answer: inferredAnswer,
      });
      if (type === "Image" && !media) {
        warnings.push(`Row ${li+2}: image question missing media URL — skipped`);
        return;
      }
      if (OPTION_REQUIRED_TYPES.has(normalizedCsvType) && !options) {
        warnings.push(`Row ${li+2}: ${type} question missing options - skipped`);
        return;
      }
      const qt = rawQuestionText || getMediaPrompt(type);
      if (!qt) { warnings.push(`Row ${li+2}: empty question — skipped`); return; }
      if (!answerVariants.length) { warnings.push(`Row ${li+2}: empty answer — skipped`); return; }

      if (rawType && !VALID_TYPE_KEYS.has(normalizedCsvType))
        warnings.push(`Row ${li+2}: unknown type "${rawType}" → defaulted to ${type}`);

      const primaryAnswer = answerVariants[0];
      const row = {
        question_text:   qt,
        answer:          primaryAnswer.value,
        answerTypeKey:   primaryAnswer.key,
        answerTypeLabel: primaryAnswer.label,
        answerVariants,
        options,
        type,
        difficulty:      diff,
        tags:            get(idx("tags")),
        media,
        explanation:     get(idx("explanation")) || get(idx("explain")),
        subtopic_hint:   get(idx("subtopic")) || get(idx("subtopic_hint")),
      };
      rows.push(row);
      if (preview.length < 5) preview.push(row);
    });

    if (!rows.length) errors.push("No valid rows found after parsing");
    return { rows, errors, warnings, preview };
  },

  groupBySubtopic(rows, defaultName) {
    const groups = {};
    for (const r of rows) {
      const key = r.subtopic_hint || defaultName;
      (groups[key] ??= []).push(r);
    }
    return groups;
  },
};

const ImageZip = {
  async parse(file) {
    if (!file) return { rows: [], errors: ["No ZIP file selected"], warnings: [], preview: [] };

    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (error) {
      return { rows: [], errors: ["Could not open ZIP file"], warnings: [error?.message || String(error)], preview: [] };
    }

    const entries = [];
    zip.forEach((relativePath, entry) => {
      if (entry.dir) return;
      if (/^__MACOSX\//.test(relativePath)) return;
      if (!ZIP_IMAGE_FILE_RE.test(relativePath)) return;
      entries.push({ relativePath, entry });
    });

    if (!entries.length) {
      return { rows: [], errors: ["ZIP contains no supported image files"], warnings: [], preview: [] };
    }

    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const rows = [];
    const preview = [];
    const warnings = [];

    for (const { relativePath, entry } of entries) {
      const parts = relativePath.split("/").filter(Boolean);
      const fileName = parts[parts.length - 1] || relativePath;
      const answer = labelFromZipSegment(fileName);
      if (!answer) {
        warnings.push(`Skipped ${relativePath}: filename does not contain a usable answer`);
        continue;
      }

      const subtopicHint = parts.length > 1 ? labelFromZipSegment(parts[parts.length - 2]) : "";
      const media = await readAsDataUrl(await entry.async("blob"));
      const answerVariants = [{ key:"answer", label:"Answer", value:answer, isDefault:true }];
      const row = {
        question_text: "Identify the picture.",
        answer,
        answerTypeKey: "answer",
        answerTypeLabel: "Answer",
        answerVariants,
        options: "",
        type: "Image",
        difficulty: "medium",
        tags: "",
        media,
        explanation: "",
        subtopic_hint: subtopicHint,
      };
      rows.push(row);
      if (preview.length < 5) preview.push(row);
    }

    if (!rows.length) return { rows: [], errors: ["ZIP contains no usable image questions"], warnings, preview: [] };
    return { rows, errors: [], warnings, preview };
  },
};

function getMediaPrompt(type) {
  const normalized = normalizeQuestionType(type);
  if (normalized === "Image") return "Identify the picture.";
  if (normalized === "Audio") return "Listen and answer.";
  return "";
}

function getQuestionAnswerEntries(question) {
  const variants = Array.isArray(question?.answerVariants)
    ? question.answerVariants
        .map((entry, index) => ({
          key: entry?.key || `answer_${index + 1}`,
          label: entry?.label || formatAnswerTypeLabel(entry?.key),
          value: String(entry?.value || "").trim(),
          isDefault: !!entry?.isDefault,
        }))
        .filter(entry => entry.value)
    : [];
  if (variants.length) return variants;
  const answer = String(question?.answer || "").trim();
  if (!answer) return [];
  return [{
    key: question?.answerTypeKey || "answer",
    label: question?.answerTypeLabel || "Answer",
    value: answer,
    isDefault: true,
  }];
}

function pickQuestionAnswerEntry(question, preferredKey = "", seed = "") {
  const entries = getQuestionAnswerEntries(question);
  if (!entries.length) return { key:"answer", label:"Answer", value:"", isDefault:true };
  if (preferredKey) {
    const exact = entries.find(entry => entry.key === preferredKey || entry.label.toLowerCase() === String(preferredKey).toLowerCase());
    if (exact) return exact;
  }
  if (!seed) return entries[0];
  return entries[hashString(`${question?.id || ""}:${seed}`) % entries.length];
}

function getQuestionAnswerPreview(question, limit = 2) {
  const entries = getQuestionAnswerEntries(question);
  if (!entries.length) return "";
  const preview = entries.slice(0, limit).map(entry =>
    entry.isDefault || entry.label === "Answer" ? entry.value : `${entry.label}: ${entry.value}`
  ).join(" · ");
  return entries.length > limit ? `${preview} …` : preview;
}

function getBaseQuestionPrompt(question) {
  if (!question) return "";
  return (question.baseQuestionText || question.question_text || "").trim() || getMediaPrompt(question);
}

function buildQuestionPrompt(question, answerEntry = null) {
  const base = getBaseQuestionPrompt(question);
  const activeAnswer = answerEntry || (
    question?.answerTypeLabel
      ? { key: question.answerTypeKey, label: question.answerTypeLabel, value: question.answer, isDefault: question.answerTypeKey === "answer" }
      : null
  );
  if (!activeAnswer || activeAnswer.isDefault || activeAnswer.label === "Answer") return base;
  const prefix = base ? (/[.?!]$/.test(base) ? base : `${base}.`) : "";
  return `${prefix}${prefix ? " " : ""}Provide the ${activeAnswer.label.toLowerCase()}.`;
}

function prepareQuestionForStudy(question, preferredKey = "", seed = "") {
  if (!question) return null;
  const answerEntry = pickQuestionAnswerEntry(question, preferredKey, seed);
  const type = normalizeQuestionType(question);
  return {
    ...question,
    type,
    baseQuestionText: getBaseQuestionPrompt(question),
    question_text: buildQuestionPrompt({ ...question, type }, answerEntry),
    answer: answerEntry.value,
    answerTypeKey: answerEntry.key,
    answerTypeLabel: answerEntry.label,
    answerVariants: getQuestionAnswerEntries(question),
  };
}

function getQuestionPrompt(question) {
  if (!question) return "";
  if (question.answerTypeLabel || question.baseQuestionText) return question.question_text || buildQuestionPrompt(question);
  return getBaseQuestionPrompt(question);
}

function getQuestionLabel(question) {
  return getQuestionPrompt(question) || "Untitled question";
}

function getAnswerPlaceholder(type, answerTypeLabel = "") {
  const normalized = normalizeQuestionType(type);
  const typedLabel = answerTypeLabel && answerTypeLabel !== "Answer" ? answerTypeLabel.toLowerCase() : "";
  if (normalized === "Image") return typedLabel ? `Type the ${typedLabel}...` : "Identify the picture...";
  if (normalized === "Audio" || normalized === "Dictation") return "Type what you hear...";
  if (typedLabel) return `Type the ${typedLabel}...`;
  return "Type your answer...";
}

function QuestionMedia({ question, maxHeight = 160, marginBottom = 10 }) {
  const mediaSrc = normalizeMediaUrl(question?.media);
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    setMediaError(false);
  }, [mediaSrc]);

  if (isImageQuestion(question)) {
    if (!mediaSrc) return null;
    if (mediaError) {
      return (
        <div style={{ width:"100%" }}>
          <div style={{ background:"var(--accent)10", border:"1px solid var(--accent)30", borderRadius:10, padding:"10px 12px", marginBottom, fontSize:12, color:"var(--accent)" }}>
            Image could not be loaded from this URL.
            <div style={{ marginTop:6 }}>
              <a href={mediaSrc} target="_blank" rel="noreferrer" style={{ color:"inherit", textDecoration:"underline" }} onClick={e => e.stopPropagation()}>
                Open image directly
              </a>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div style={{ width:"100%" }}>
        <img
          src={mediaSrc}
          alt="Question prompt"
          referrerPolicy="no-referrer"
          style={{ maxWidth:"100%", maxHeight, borderRadius:10, marginBottom, objectFit:"contain", display:"block" }}
          onError={() => setMediaError(true)}
        />
      </div>
    );
  }
  if (normalizeQuestionType(question) === "Audio") {
    return <audio controls src={mediaSrc} style={{ width:"100%", marginBottom }} onClick={e => e.stopPropagation()} />;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// §6  SPEECH ENGINE  — with WebKit fallback + pronunciation scoring
// ══════════════════════════════════════════════════════════════
const Speech = {
  _speakTimer : null,
  _speakSeq   : 0,
  _voices     : null,   // cached after first voiceschanged event

  // ── Voice cache ───────────────────────────────────────────
  // speechSynthesis.getVoices() returns [] synchronously on first call in
  // most browsers; the real list fires via the voiceschanged event.
  // We cache once and keep it for the lifetime of the page.
  _ensureVoices() {
    if (this._voices?.length) return;
    if (!window.speechSynthesis?.getVoices) return;
    const list = window.speechSynthesis.getVoices();
    if (list.length) { this._voices = list; return; }
    // Register a one-shot listener for async voice load
    if (!this._voiceListenerAttached) {
      this._voiceListenerAttached = true;
      window.speechSynthesis.onvoiceschanged = () => {
        this._voices = window.speechSynthesis.getVoices();
      };
    }
  },

  _normalizeSpeakText(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return "";
    // Append a comma so the engine registers a pause boundary and speaks the
    // full word rather than clipping the tail.  Applies to ALL text (not just
    // single words) because it is harmless for multi-word strings too.
    return `${value},`;
  },

  _pickVoice(lang) {
    this._ensureVoices();
    const voices = this._voices || [];
    if (!voices.length) return null;
    const exact = voices.find(v => v.lang === lang);
    if (exact) return exact;
    const base = lang.split("-")[0]?.toLowerCase();
    return voices.find(v => v.lang?.toLowerCase().startsWith(base)) || null;
  },

  _buildUtterance(text, lang, rate = 1, volume = 1) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang   = lang;
    u.rate   = rate;
    u.volume = volume;
    const voice = this._pickVoice(lang);
    if (voice) u.voice = voice;
    return u;
  },

  speak(text, lang = "en-US", rate = 1, onEnd = null) {
    if (!window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const spokenText = this._normalizeSpeakText(text);
    if (!spokenText) { onEnd?.(); return; }

    // ── Stop everything in-flight ────────────────────────────────────────
    if (this._speakTimer) { clearTimeout(this._speakTimer); this._speakTimer = null; }
    this._speakSeq += 1;
    const seq = this._speakSeq;
    synth.cancel();

    const queue = (fn, delay) => {
      this._speakTimer = window.setTimeout(() => {
        this._speakTimer = null;
        if (seq !== this._speakSeq) return;
        fn();
      }, delay);
    };

    const speakMain = () => {
      if (seq !== this._speakSeq) return;
      const u = this._buildUtterance(spokenText, lang, rate, 1);
      u.onend  = () => { if (seq === this._speakSeq) onEnd?.(); };
      // "interrupted" fires when cancel() is called on an active utterance.
      // We must NOT invoke onEnd then — the next speak() call has taken over.
      u.onerror = e => { if (e?.error !== "interrupted" && seq === this._speakSeq) onEnd?.(); };
      synth.speak(u);
      synth.resume?.();
    };

    // ── Warm-up primer ───────────────────────────────────────────────────
    // iOS/Safari clips the first syllable because the audio session is not
    // open yet.  A near-silent two-word utterance forces the session open.
    //
    // CRITICAL — primer must be multi-word ("a a", NOT "a"):
    //   Single-word utterances are subject to the same first-syllable clipping
    //   bug we are trying to work around.  A single-word primer is silently
    //   swallowed on iOS, onend never fires, and speakMain is never called —
    //   which was the root cause of complete silence on single-word cards.
    //
    // Volume 0.01: volume 0 causes WebKit to skip the utterance without
    // firing onend/onerror.  0.01 is inaudible in practice (~−40 dB) but
    // reliably produces events.
    //
    // Hard fallback timeout (1 000 ms): if onend/onerror both fail to fire
    // (e.g. iOS locked screen, audio session forcibly closed by OS),
    // speakMain is called anyway so the card doesn't stay forever silent.
    const primeAndSpeak = () => {
      if (seq !== this._speakSeq) return;
      let primerDone = false;
      const afterPrimer = () => {
        if (primerDone) return;
        primerDone = true;
        queue(speakMain, 200);
      };
      const primer = this._buildUtterance("a a", lang, 1, 0.01);
      primer.onend   = afterPrimer;
      primer.onerror = afterPrimer;
      synth.speak(primer);
      synth.resume?.();
      // Hard fallback — fires if primer events never arrive
      window.setTimeout(() => { if (seq === this._speakSeq) afterPrimer(); }, 1000);
    };

    // Wait 150 ms after cancel() so the browser fully clears its queue
    queue(primeAndSpeak, 150);
  },

  cancel() {
    if (this._speakTimer) { clearTimeout(this._speakTimer); this._speakTimer = null; }
    this._speakSeq += 1;
    window.speechSynthesis?.cancel();
  },

  listen(onResult, onEnd, lang = "en-US") {
    // Use webkit fallback if standard API unavailable
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { onEnd?.(); return null; }
    const r = new SR();
    r.lang = lang; r.interimResults = false; r.maxAlternatives = 3;
    r.onresult = e => {
      const alts = Array.from(e.results[0]).map(a => ({ text: a.transcript, conf: a.confidence }));
      const best = alts.sort((a, b) => b.conf - a.conf)[0];
      onResult(best.text, best.conf, alts);
    };
    r.onerror = () => onEnd?.();
    r.onend   = onEnd;
    r.start();
    return r;
  },

  scorePronunciation(spoken, expected, tolerance = 0.7) {
    const s = spoken.toLowerCase().trim();
    const e = expected.toLowerCase().trim();
    if (s === e) return { score: 100, pass: true, feedback: "Perfect pronunciation!" };
    const dist = this._lev(s, e);
    const sim  = 1 - dist / Math.max(s.length, e.length, 1);
    const score = Math.round(sim * 100);
    const pass  = sim >= tolerance;
    const feedback = score >= 90 ? "Excellent!" : score >= 75 ? "Good — minor variation." : score >= 55 ? "Fair — try again." : "Keep practicing!";
    return { score, pass, feedback, spoken };
  },

  _lev(a, b) {
    const [m, n] = [a.length, b.length];
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  },
};

// ══════════════════════════════════════════════════════════════
// §7  CRYPTO ENGINE  — optional AES-GCM local encryption
// ══════════════════════════════════════════════════════════════
const Crypto = {
  async deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode("FlashMasterSalt"), iterations: 100000, hash: "SHA-256" },
      keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt","decrypt"]
    );
  },

  async encrypt(data, password) {
    try {
      const key = await this.deriveKey(password);
      const iv  = window.crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const ct  = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
      return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
    } catch { return null; }
  },

  async decrypt(payload, password) {
    try {
      const key  = await this.deriveKey(password);
      const iv   = new Uint8Array(payload.iv);
      const ct   = new Uint8Array(payload.ct);
      const pt   = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { return null; }
  },
};

// ══════════════════════════════════════════════════════════════
// §8  UTILITIES
// ══════════════════════════════════════════════════════════════
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const AVATARS = ["🦁","🐯","🦊","🐺","🦝","🐻","🐼","🦉","🦅","🦋","🐬","🦄","🦸","🧙","🧑‍🚀","🧑‍🎨"];

const PROFILE_LOCK_TTL_MS = 45_000;
const PROFILE_LOCK_HEARTBEAT_MS = 15_000;

function getLocalDeviceId() {
  try {
    const existing = localStorage.getItem("fm_device_id");
    if (existing) return existing;
    const next = `dev_${uid()}`;
    localStorage.setItem("fm_device_id", next);
    return next;
  } catch {
    return `dev_${uid()}`;
  }
}

function getLocalDeviceLabel() {
  const nav = window.navigator || {};
  const ua = String(nav.userAgent || "").toLowerCase();
  const browser = ua.includes("edg/") ? "Edge"
    : ua.includes("chrome/") ? "Chrome"
    : ua.includes("firefox/") ? "Firefox"
    : ua.includes("safari/") && !ua.includes("chrome/") ? "Safari"
    : "Browser";
  const platform = /android/i.test(ua) ? "Android"
    : /iphone|ipad|ipod/i.test(ua) ? "iPhone"
    : /win/i.test(String(nav.platform || "")) ? "Windows"
    : /mac/i.test(String(nav.platform || "")) ? "Mac"
    : /linux/i.test(String(nav.platform || "")) ? "Linux"
    : "Device";
  return `${browser} on ${platform}`;
}

function isProfileLockActive(lock) {
  if (!lock?.updatedAt) return false;
  const updatedAt = new Date(lock.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt < PROFILE_LOCK_TTL_MS;
}

function getProfileLockLabel(lock) {
  if (!lock) return "";
  const owner = lock.deviceLabel || "another device";
  if (!isProfileLockActive(lock)) return `Last active on ${owner}`;
  return `Active on ${owner}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function haptic(type = "light") {
  if (!navigator.vibrate) return;
  ({ light:[10], medium:[20], heavy:[40], success:[10,50,10], error:[50] })[type]
    ?.forEach((ms, i) => setTimeout(() => navigator.vibrate(ms), i * 60));
}

function dayStr(d = new Date()) { return d.toISOString().slice(0, 10); }

const DEFAULT_SETTINGS = {
  // General
  theme: "dark", fontSize: "medium", uiLang: "en", hapticFeedback: true, focusMode: false,
  // TTS / Voice
  autoTTS: true, ttsLang: "en-US", ttsRate: 1.0,
  repeatAfterMe: false, voiceScoring: true, accentTolerance: 0.70,
  // Learning
  spacedRepetition: true, smartShuffle: true, repetitionCount: 3,
  dailyFlashGoal: 20, dailyQuizGoal: 3, dailyStudyGoal: 30,
  showForgettingCurve: true, deckLimit: 50,
  // Quiz
  passThreshold: 70, timerSec: 30, quizLen: 10,
  adaptiveQuiz: true, showExplanations: true,
  // Flash
  autoRevealTime: 10, hintMode: false,
  // Security
  encryptBackup: false, encryptPassword: "",
};

// ══════════════════════════════════════════════════════════════
// §9  APP CONTEXT
// ══════════════════════════════════════════════════════════════
const Ctx = createContext();
const useApp = () => useContext(Ctx);

function AppProvider({ children }) {
  const [dbReady,     setDbReady]     = useState(false);
  const [profiles,    setProfiles]    = useState([]);
  const [subjects,    setSubjects]    = useState([]);
  const [topics,      setTopics]      = useState([]);
  const [subtopics,   setSubtopics]   = useState([]);
  const [questions,   setQuestions]   = useState([]);
  const [flashProg,   setFlashProg]   = useState([]);
  const [quizAttempts,setQA]          = useState([]);
  const [leaderboard, setLB]          = useState([]);
  const [reviewHistory,setRH]         = useState([]);
  // ── Google auth state ──────────────────────────────────────
  const [googleUser,  setGoogleUser]  = useState(() => {
    try { return JSON.parse(localStorage.getItem("fm_google_user") || "null"); } catch { return null; }
  });
  const googleClientId = GOOGLE_CLIENT_ID;
  const deviceId = useMemo(() => getLocalDeviceId(), []);
  const deviceLabel = useMemo(() => getLocalDeviceLabel(), []);
  const [gdriveSyncing, setGdriveSyncing] = useState(false);
  const [gdriveStatus,  setGdriveStatus]  = useState("");
  const [googleAuthChecking, setGoogleAuthChecking] = useState(false);
  const [profileLocks, setProfileLocks] = useState({});
  const [lastSyncedAt,  setLastSyncedAt]  = useState(() =>
    localStorage.getItem("fm_last_synced") || ""
  );
  // Debounce ref for continuous auto-sync
  const autoSyncTimer = useRef(null);
  const cloudPullPromise = useRef(null);
  const profileLockBeatRef = useRef(null);
  const activeProfileLockRef = useRef(null);
  const [settings,    setSettings]    = useState(() => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("fm_settings") || "{}") }; }
    catch { return DEFAULT_SETTINGS; }
  });
  const [streak, setStreak] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fm_streak") || "null") || { count: 0, lastDate: null }; }
    catch { return { count: 0, lastDate: null }; }
  });
  const [daily, setDaily] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fm_daily") || "null") || { date: null, flash: 0, quiz: 0 }; }
    catch { return { date: null, flash: 0, quiz: 0 }; }
  });
  const [currentProfile, setCP]   = useState(null);
  const [screen,          setScreen]  = useState("google_login");
  const [nav,             setNav]     = useState({});
  const [toast,           setToast]   = useState(null);
  const [focusMode,       setFocusMode]= useState(false);
  const [pwaPrompt,       setPwaPrompt]= useState(null);

  // Apply theme + font
  useEffect(() => {
    const root = document.documentElement;
    const fs = { small:"13px", medium:"15px", large:"17px" }[settings.fontSize] || "15px";
    root.style.setProperty("--base-font", fs);
    const dark = settings.theme === "dark";
    root.style.setProperty("--bg",      dark ? "#060A16" : "#F4F6FB");
    root.style.setProperty("--surface", dark ? "#0C1020" : "#EAECF5");
    root.style.setProperty("--card",    dark ? "#111825" : "#FFFFFF");
    root.style.setProperty("--border",  dark ? "#1A2135" : "#D8DCF0");
    root.style.setProperty("--text",    dark ? "#E2E8F0" : "#1A2232");
    root.style.setProperty("--muted",   dark ? "#5A6882" : "#7A8FAD");
  }, [settings.theme, settings.fontSize]);

  // PWA
  useEffect(() => {
    const h = e => { e.preventDefault(); setPwaPrompt(e); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);

  // Boot: open Dexie DB and load all data
  useEffect(() => {
    (async () => {
      try {
        const db = await getDB(); // triggers Dexie open + migration
        const [p, allSubjects, allTopics, allSubtopics, q, allProgress, allQA, lb, allRH] = await Promise.all([
          db.profiles.toArray(),
          db.subjects.toArray(),
          db.topics.toArray(),
          db.subtopics.toArray(),
          db.questions.toArray(),
          db.flashProgress.toArray(),
          db.quizAttempts.toArray(),
          db.leaderboard.toArray(),
          db.reviewHistory.toArray(),
        ]);
        setProfiles(p); setSubjects(allSubjects); setTopics(allTopics);
        setSubtopics(allSubtopics); setQuestions(q); setFlashProg(allProgress);
        setQA(allQA); setLB(lb); setRH(allRH);
        setDbReady(true);
      } catch (e) {
        console.error("[FM4] DB boot error:", e);
        setDbReady(true); // fallback gracefully
      }
    })();
  }, []);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  }

  function navigate(to, ctx = {}) {
    Speech.cancel();
    setScreen(to);
    setNav(prev => ({ ...prev, ...ctx }));
  }

  // ── Derived: profile-scoped data ──────────────────────────
  const uid_ = currentProfile?.id;
  const userSubjects  = useMemo(() => subjects.filter(s => s.uid === uid_),   [subjects, uid_]);
  const userProgress  = useMemo(() => flashProg.filter(f => f.uid === uid_),  [flashProg, uid_]);
  const userQA        = useMemo(() => quizAttempts.filter(a => a.uid === uid_),[quizAttempts, uid_]);
  const userRH        = useMemo(() => reviewHistory.filter(r => r.uid === uid_),[reviewHistory, uid_]);

  // O(1) lookup maps
  const progMap       = useMemo(() => new Map(userProgress.map(f => [f.qid, f])), [userProgress]);
  const questionMap   = useMemo(() => new Map(questions.map(q => [q.id, q])),     [questions]);
  const subtopicMap   = useMemo(() => new Map(subtopics.map(s => [s.id, s])),     [subtopics]);
  const topicMap      = useMemo(() => new Map(topics.map(t => [t.id, t])),        [topics]);
  const subjectMap    = useMemo(() => new Map(subjects.map(s => [s.id, s])),      [subjects]);

  // ── Streak ────────────────────────────────────────────────
  function tickStreak() {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86_400_000).toDateString();
    const s = streak.lastDate === today ? streak
            : streak.lastDate === yesterday ? { count: streak.count + 1, lastDate: today }
            : { count: 1, lastDate: today };
    setStreak(s);
    localStorage.setItem("fm_streak", JSON.stringify(s));
    return s;
  }

  function getTodayDP() {
    const today = new Date().toDateString();
    return daily.date === today ? daily : { date: today, flash: 0, quiz: 0 };
  }

  // ── Settings ──────────────────────────────────────────────
  function saveSettings(newS) {
    const merged = { ...settings, ...newS };
    setSettings(merged);
    localStorage.setItem("fm_settings", JSON.stringify(merged));
    showToast("Settings saved!");
  }

  // ── Profile ops ───────────────────────────────────────────
  async function createProfile(name, avatar) {
    const p = { id: uid(), name, avatar, created_at: new Date().toISOString() };
    await DB.putProfile(p);
    setProfiles(prev => [...prev, p]);
    showToast(`Profile "${name}" created!`);
    return p;
  }

  async function deleteProfile(id) {
    await DB.clearUserData(id);
    await DB.deleteProfile(id);
    const deletedSubjectIds = subjects.filter(s => s.uid === id).map(s => s.id);
    setProfiles(prev => prev.filter(p => p.id !== id));
    setSubjects(prev => prev.filter(s => s.uid !== id));
    setTopics(prev => prev.filter(t => !deletedSubjectIds.includes(t.sid)));
    setFlashProg(prev => prev.filter(f => f.uid !== id));
    setQA(prev => prev.filter(a => a.uid !== id));
    setRH(prev => prev.filter(r => r.uid !== id));
    if (currentProfile?.id === id) { setCP(null); setScreen("profiles"); }
    showToast("Profile deleted");
  }

  // ── Subject ops ───────────────────────────────────────────
  async function createSubject(name, language = "English") {
    const s = { id: uid(), uid: uid_, name, language };
    await DB.putSubject(s);
    setSubjects(prev => [...prev, s]);
    showToast(`Subject "${name}" created`);
    return s;
  }

  async function deleteSubject(id) {
    const tids  = topics.filter(t => t.sid === id).map(t => t.id);
    const stids = subtopics.filter(s => tids.includes(s.tid)).map(s => s.id);
    const qids  = new Set(questions.filter(q => stids.includes(q.stid)).map(q => q.id));
    setSubjects(p => p.filter(s => s.id !== id));
    setTopics(p => p.filter(t => t.sid !== id));
    setSubtopics(p => p.filter(s => !tids.includes(s.tid)));
    setQuestions(p => p.filter(q => !qids.has(q.id)));
    setFlashProg(p => p.filter(f => !qids.has(f.qid)));
    await DB.deleteSubject(id);
    showToast("Subject deleted");
  }

  async function createTopic(sid, name) {
    const t = { id: uid(), sid, name };
    await DB.putTopic(t);
    setTopics(prev => [...prev, t]);
    return t;
  }

  async function deleteTopic(id) {
    const stids = subtopics.filter(s => s.tid === id).map(s => s.id);
    const qids  = new Set(questions.filter(q => stids.includes(q.stid)).map(q => q.id));
    setTopics(p => p.filter(t => t.id !== id));
    setSubtopics(p => p.filter(s => s.tid !== id));
    setQuestions(p => p.filter(q => !qids.has(q.id)));
    setFlashProg(p => p.filter(f => !qids.has(f.qid)));
    await DB.deleteTopic(id);
  }

  async function createSubtopic(tid, name) {
    const s = { id: uid(), tid, name };
    await DB.putSubtopic(s);
    setSubtopics(prev => [...prev, s]);
    return s;
  }

  async function deleteSubtopic(id) {
    const qids = new Set(questions.filter(q => q.stid === id).map(q => q.id));
    setSubtopics(p => p.filter(s => s.id !== id));
    setQuestions(p => p.filter(q => q.stid !== id));
    setFlashProg(p => p.filter(f => !qids.has(f.qid)));
    await DB.deleteSubtopic(id);
  }

  // ── CSV Import ────────────────────────────────────────────
  async function importCSVToSubject(subjectId, topicName, rows) {
    const groups = CSV.groupBySubtopic(rows, topicName);
    let topic = topics.find(t => t.sid === subjectId && t.name.toLowerCase() === topicName.toLowerCase());
    if (!topic) topic = await createTopic(subjectId, topicName);

    const newSTs = [], newQs = [];
    for (const [stName, stRows] of Object.entries(groups)) {
      let st = subtopics.find(s => s.tid === topic.id && s.name.toLowerCase() === stName.toLowerCase());
      if (!st) { st = { id: uid(), tid: topic.id, name: stName }; newSTs.push(st); }
      for (const r of stRows) {
        const { subtopic_hint, ...rest } = r;
        newQs.push({ id: uid(), stid: st.id, ...rest });
      }
    }
    await DB.bulkPutSubtopics(newSTs);
    await DB.bulkPutQuestions(newQs);
    setSubtopics(p => [...p, ...newSTs]);
    setQuestions(p => [...p, ...newQs]);
    return { topicName, subtopicCount: Object.keys(groups).length, questionCount: newQs.length };
  }

  async function addQuestion(stid, q) {
    const item = { id: uid(), stid, ...q };
    await DB.putQuestion(item);
    setQuestions(prev => [...prev, item]);
    showToast("Question added!");
  }

  async function deleteQuestion(id) {
    await DB.deleteQuestion(id);
    setQuestions(p => p.filter(q => q.id !== id));
    setFlashProg(p => p.filter(f => f.qid !== id));
    setRH(p => p.filter(r => r.qid !== id));
  }

  // ── Flash Progress ─────────────────────────────────────────
  async function applyRating(qid, rating, responseMs = 0) {
    if (!uid_) return;
    const prev = progMap.get(qid) || { id: uid(), uid: uid_, qid };
    const update = SRS.apply(prev, rating);
    const entry  = { ...prev, ...update, id: prev.id || uid() };
    await DB.putProgress(entry);
    setFlashProg(p => {
      const idx = p.findIndex(f => f.uid === uid_ && f.qid === qid);
      return idx >= 0 ? p.map((f, i) => i === idx ? entry : f) : [...p, entry];
    });

    // Log to reviewHistory (critical for analytics)
    const rh = {
      id: uid(), uid: uid_, qid,
      grade: rating, correct: update.correct,
      responseMs, timestamp: Date.now(),
      easeFactor: update.easeFactor, interval: update.interval,
      box: update.box, status: update.status,
    };
    await DB.addReview(rh);
    setRH(p => [...p, rh]);

    // Daily counter
    if (update.correct) {
      const today = new Date().toDateString();
      const d = daily.date === today ? daily : { date: today, flash: 0, quiz: 0 };
      const nd = { ...d, date: today, flash: d.flash + 1 };
      setDaily(nd);
      localStorage.setItem("fm_daily", JSON.stringify(nd));
    }
    tickStreak();
    if (settings.hapticFeedback) haptic(update.correct ? "success" : "error");
    return update;
  }

  async function resetSubtopicProgress(stid) {
    const qids = questions.filter(q => q.stid === stid).map(q => q.id);
    const toDelete = userProgress.filter(f => qids.includes(f.qid)).map(f => f.id);
    setFlashProg(p => p.filter(f => !toDelete.includes(f.id)));
    const db = await getDB();
    await db.flashProgress.bulkDelete(toDelete);
    showToast("Progress reset!", "info");
  }

  // ── Session draft ──────────────────────────────────────────
  async function saveSessionDraft(draft) {
    const entry = { id: uid_, uid: uid_, ...draft, savedAt: Date.now() };
    await DB.putSessionDraft(entry);
  }

  async function loadSessionDraft() {
    return DB.getSessionDraft(uid_);
  }

  async function clearSessionDraft() {
    await DB.clearSessionDraft(uid_);
  }

  // ── Quiz ops ───────────────────────────────────────────────
  async function saveQuizAttempt(stid, tid, score, total, results = []) {
    const pct = total > 0 ? Math.round(score / total * 100) : 0;
    const a = {
      id: uid(), uid: uid_, tid, stid, score, total, pct,
      attempt_date: new Date().toISOString(),
      results: results.map(r => ({ qid: r.question?.id, correct: r.correct, answer: r.answer })),
    };
    await DB.putQuizAttempt(a);
    setQA(p => [...p, a]);

    // Leaderboard
    const existing = leaderboard.find(l => l.uid === uid_);
    const lb = {
      id: existing?.id || uid(), uid: uid_,
      name: currentProfile.name, avatar: currentProfile.avatar,
      totalScore: (existing?.totalScore || 0) + score,
      totalQ:     (existing?.totalQ || 0) + total,
      quizCount:  (existing?.quizCount || 0) + 1,
      bestPct:    Math.max(existing?.bestPct || 0, pct),
      avgPct:     Math.round(((existing?.avgPct || 0) * (existing?.quizCount || 0) + pct) / ((existing?.quizCount || 0) + 1)),
      lastUpdated: new Date().toISOString(),
    };
    await DB.putLeaderboard(lb);
    setLB(p => existing ? p.map(l => l.uid === uid_ ? lb : l) : [...p, lb]);

    const today = new Date().toDateString();
    const d = daily.date === today ? daily : { date: today, flash: 0, quiz: 0 };
    const nd = { ...d, date: today, quiz: d.quiz + 1 };
    setDaily(nd);
    localStorage.setItem("fm_daily", JSON.stringify(nd));
    tickStreak();
    return pct;
  }

  // ── Analytics helpers ──────────────────────────────────────
  function getAccuracy(qid) {
    const p = progMap.get(qid);
    return p?.totalShown > 0 ? p.correctCount / p.totalShown : null;
  }

  function getWeakLessons() {
    return subtopics.map(st => {
      const qs = questions.filter(q => q.stid === st.id);
      if (qs.length < 2) return null;
      const progs = qs.map(q => progMap.get(q.id)).filter(p => p && p.totalShown >= 2);
      if (progs.length < 2) return null;
      const acc = progs.reduce((a, p) => a + p.correctCount / p.totalShown, 0) / progs.length;
      if (acc >= 0.5) return null;
      const topic   = topicMap.get(st.tid);
      const subject = topic ? subjectMap.get(topic.sid) : null;
      return { subtopic: st, topic, subject, accuracy: Math.round(acc * 100), questions: qs };
    }).filter(Boolean).sort((a, b) => a.accuracy - b.accuracy);
  }

  // ── Adaptive quiz selection ────────────────────────────────
  function selectAdaptive(pool, count) {
    if (!settings.adaptiveQuiz) return shuffle(pool).slice(0, count);
    const scored = pool.map(q => {
      const acc = getAccuracy(q.id);
      const w = acc === null ? 2 : acc < 0.4 ? 4 : acc < 0.6 ? 2.5 : acc < 0.8 ? 1.5 : 1;
      return { q, w };
    });
    const out = [];
    const pool_ = [...scored];
    while (out.length < count && pool_.length) {
      const total = pool_.reduce((a, x) => a + x.w, 0);
      let r = Math.random() * total;
      for (let i = 0; i < pool_.length; i++) {
        r -= pool_[i].w;
        if (r <= 0) { out.push(pool_[i].q); pool_.splice(i, 1); break; }
      }
    }
    return out;
  }

  // ── Daily plan ─────────────────────────────────────────────
  const dailyPlan = useMemo(() => {
    if (!uid_ || !questions.length) return null;
    const myQs = questions.filter(q => {
      const st = subtopicMap.get(q.stid);
      if (!st) return false;
      const t = topicMap.get(st.tid);
      if (!t) return false;
      return subjects.some(s => s.uid === uid_ && s.id === t.sid);
    });
    const rq = ReviewQueue.build(myQs, progMap, 9999);
    const recentPct = userQA.slice(-5).map(a => a.pct || 0);
    const avgScore  = recentPct.length ? recentPct.reduce((a, b) => a + b, 0) / recentPct.length : 75;
    return {
      newCount:      rq.newCount,
      dueCount:      rq.dueCount,
      learningCount: rq.learningCount,
      masteredCount: rq.masteredCount,
      total:         rq.total,
      flashTarget:   settings.dailyFlashGoal,
      quizTarget:    avgScore < 60 ? 3 : avgScore < 80 ? 2 : 1,
      weakCount:     getWeakLessons().length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid_, questions, userProgress, userQA, settings.dailyFlashGoal]);

  // ── Google Sign-In (mandatory, first screen) ───────────────
  const reloadCloudData = useCallback(async () => {
    const db = await getDB();
    const [p, allS, allT, allST, allQ, allFP, allQA, allLB, allRH] = await Promise.all([
      db.profiles.toArray(), db.subjects.toArray(), db.topics.toArray(),
      db.subtopics.toArray(), db.questions.toArray(), db.flashProgress.toArray(),
      db.quizAttempts.toArray(), db.leaderboard.toArray(), db.reviewHistory.toArray(),
    ]);
    setProfiles(p); setSubjects(allS); setTopics(allT); setSubtopics(allST);
    setQuestions(allQ); setFlashProg(allFP); setQA(allQA); setLB(allLB); setRH(allRH);
    setCP(prev => prev ? p.find(profile => profile.id === prev.id) || null : prev);
  }, []);

  const refreshProfileLocks = useCallback(async () => {
    if (!googleUser || !googleClientId) return {};
    try {
      const locks = await GDrive.listProfileLocks(googleClientId);
      const next = Object.fromEntries(
        locks
          .map(({ data }) => [data?.profileId, data])
          .filter(([profileId, data]) => profileId && data)
      );
      setProfileLocks(next);
      return next;
    } catch (e) {
      console.warn("[FM6] Refresh profile locks failed:", e.message);
      return {};
    }
  }, [googleClientId, googleUser]);

  const writeProfileLock = useCallback(async profileId => {
    if (!googleUser || !googleClientId || !profileId) return null;
    const lock = {
      profileId,
      deviceId,
      deviceLabel,
      googleEmail: googleUser.email || "",
      updatedAt: new Date().toISOString(),
    };
    await GDrive.putProfileLock(googleClientId, profileId, lock);
    activeProfileLockRef.current = lock;
    setProfileLocks(prev => ({ ...prev, [profileId]: lock }));
    return lock;
  }, [deviceId, deviceLabel, googleClientId, googleUser]);

  const stopProfileLockHeartbeat = useCallback(() => {
    if (profileLockBeatRef.current) {
      clearInterval(profileLockBeatRef.current);
      profileLockBeatRef.current = null;
    }
  }, []);

  const startProfileLockHeartbeat = useCallback(profileId => {
    stopProfileLockHeartbeat();
    profileLockBeatRef.current = window.setInterval(() => {
      writeProfileLock(profileId).catch(e => {
        console.warn("[FM6] Profile lock heartbeat failed:", e.message);
      });
    }, PROFILE_LOCK_HEARTBEAT_MS);
  }, [stopProfileLockHeartbeat, writeProfileLock]);

  useEffect(() => () => stopProfileLockHeartbeat(), [stopProfileLockHeartbeat]);

  const releaseProfileLock = useCallback(async (profileId = activeProfileLockRef.current?.profileId) => {
    stopProfileLockHeartbeat();
    if (!googleClientId || !profileId) {
      activeProfileLockRef.current = null;
      return;
    }

    try {
      const remoteLock = await GDrive.getProfileLock(googleClientId, profileId);
      if (!remoteLock || remoteLock.deviceId === deviceId || !isProfileLockActive(remoteLock)) {
        await GDrive.deleteProfileLock(googleClientId, profileId);
      }
    } catch (e) {
      console.warn("[FM6] Release profile lock failed:", e.message);
    } finally {
      activeProfileLockRef.current = null;
      setProfileLocks(prev => {
        const next = { ...prev };
        const lock = next[profileId];
        if (!lock || lock.deviceId === deviceId || !isProfileLockActive(lock)) delete next[profileId];
        return next;
      });
    }
  }, [deviceId, googleClientId, stopProfileLockHeartbeat]);

  const enterProfile = useCallback(async profile => {
    if (!profile) return false;
    if (!googleUser || !googleClientId) {
      showToast("Sign in to Google first!", "error");
      return false;
    }

    // If the GIS token is expired we cannot reach Drive for lock checks, but the
    // user is still identified by their cached Google account and should not be
    // locked out of their own data.  Skip lock ops gracefully and proceed.
    if (!GDrive.hasValidToken()) {
      setCP(profile);
      navigate("dashboard");
      return true;
    }

    try {
      const remoteLock = await GDrive.getProfileLock(googleClientId, profile.id);
      if (remoteLock && isProfileLockActive(remoteLock) && remoteLock.deviceId !== deviceId) {
        setProfileLocks(prev => ({ ...prev, [profile.id]: remoteLock }));
        showToast(`${profile.name} is active on another device`, "error");
        return false;
      }
      await writeProfileLock(profile.id);
      startProfileLockHeartbeat(profile.id);
      setCP(profile);
      navigate("dashboard");
      return true;
    } catch (e) {
      console.error("[FM6] Profile lock error:", e);
      // Token expired mid-flight — still let the user in; sync will recover.
      if (/access_denied|token|401|403/i.test(e.message)) {
        setCP(profile);
        navigate("dashboard");
        return true;
      }
      showToast("Could not lock profile: " + e.message, "error");
      return false;
    }
  }, [deviceId, googleClientId, googleUser, navigate, showToast, startProfileLockHeartbeat, writeProfileLock]);

  const restoreDriveProfiles = useCallback(async (
    statusMessage = "Downloading your profiles from Drive…",
    mode = "replace",
  ) => {
    if (cloudPullPromise.current) return cloudPullPromise.current;

    const work = (async () => {
      if (statusMessage) setGdriveStatus(statusMessage);
      const results = await GDrive.syncAllDown(googleClientId);
      if (!results.length) return 0;

      let imported = 0;
      for (const { data } of results) {
        if (!data?.profiles?.length) continue;
        if (mode === "replace") await replaceProfileSnapshots(data);
        else await DB.importAll(data);
        imported += data.profiles.length;
      }
      await reloadCloudData();
      return imported;
    })();

    cloudPullPromise.current = work;
    try {
      return await work;
    } finally {
      cloudPullPromise.current = null;
    }
  }, [googleClientId, reloadCloudData]);

  const completeGoogleSession = useCallback(async (token, options = {}) => {
    const { restoreProfiles = true } = options;
    const userInfo = await GDrive.getUserInfo(token);
    const user = {
      id      : userInfo.id,
      email   : userInfo.email,
      name    : userInfo.name,
      picture : userInfo.picture,
    };
    setGoogleUser(user);
    localStorage.setItem("fm_google_user", JSON.stringify(user));

    if (restoreProfiles) {
      try {
        await restoreDriveProfiles("Downloading your profiles from Drive…", "replace");
      } catch (e) {
        console.warn("[FM6] Drive pull on login:", e.message);
      }
    }

    await refreshProfileLocks();
    setGdriveStatus("");
    setScreen("profiles");
    return user;
  }, [refreshProfileLocks, restoreDriveProfiles]);

  const checkGoogleSignInStatus = useCallback(async () => {
    if (!googleClientId.trim()) return false;

    setGoogleAuthChecking(true);
    try {
      setGdriveStatus("Checking Google sign-in…");
      const token = await GDrive.requestToken(googleClientId, false);
      // Silent success — refresh token + user info but skip full Drive restore.
      // The background pull effect handles incremental syncs every 30 s.
      await completeGoogleSession(token, { restoreProfiles: false });
      return true;
    } catch (e) {
      console.warn("[FM6] Silent Google session check failed:", e.message);

      // If we have a cached user, keep them logged in with local data.
      // Only a full sign-out or revocation should clear the account.
      const cachedUser = (() => {
        try { return JSON.parse(localStorage.getItem("fm_google_user") || "null"); }
        catch { return null; }
      })();

      if (cachedUser) {
        // Stay logged in; Drive sync will recover once the user explicitly
        // signs in again or the token client manages a silent refresh later.
        setGoogleUser(cachedUser);
        setGdriveStatus("⚠️ Drive sync paused — tap ☁️ Push to re-authenticate");
        setScreen("profiles");
        return false;
      }

      // No cached user at all → must sign in from scratch
      stopProfileLockHeartbeat();
      activeProfileLockRef.current = null;
      GDrive.revokeToken();
      setGoogleUser(null);
      setProfileLocks({});
      localStorage.removeItem("fm_google_user");
      setGdriveStatus("");
      setScreen("google_login");
      return false;
    } finally {
      setGoogleAuthChecking(false);
    }
  }, [completeGoogleSession, googleClientId, stopProfileLockHeartbeat]);

  async function googleSignIn() {
    if (!googleClientId.trim()) {
      showToast("Google OAuth is not configured", "error");
      return;
    }
    setGoogleAuthChecking(true);
    try {
      setGdriveStatus("Signing in…");
      const token = await GDrive.requestToken(googleClientId, true);
      const user = await completeGoogleSession(token);
      showToast(`Welcome, ${user.name}! ✅`);
      return user;
    } catch (e) {
      console.error("[FM6] Google sign-in error:", e);
      setGdriveStatus("");
      showToast("Google sign-in failed: " + e.message, "error");
    } finally {
      setGoogleAuthChecking(false);
    }
  }

  async function googleSignOut(silent = false) {
    await releaseProfileLock(currentProfile?.id);
    GDrive.revokeToken();
    setGoogleUser(null);
    setGoogleAuthChecking(false);
    setProfileLocks({});
    localStorage.removeItem("fm_google_user");
    setCP(null);
    setGdriveStatus("");
    setScreen("google_login");
    if (!silent) showToast("Signed out");
  }

  async function googleSwitchAccount() {
    await releaseProfileLock(currentProfile?.id);
    GDrive.revokeToken();
    return googleSignIn();
  }

  // ── Continuous auto-sync engine ────────────────────────────
  // Watches key data slices; debounces 4 s then pushes current profile to Drive.
  useEffect(() => {
    if (!googleUser || !googleClientId || !uid_) return;
    if (autoSyncTimer.current) clearTimeout(autoSyncTimer.current);
    autoSyncTimer.current = setTimeout(async () => {
      // Abort silently if the access token has expired.  The user will need to
      // re-authenticate (via the ☁️ button) before background sync resumes.
      if (!GDrive.hasValidToken()) {
        setGdriveSyncing(false);
        return;
      }
      try {
        setGdriveSyncing(true);
        setGdriveStatus("⏳ Syncing…");
        const data = await DB.exportAll();
        const profileData = buildProfileSyncData(data, uid_);
        await GDrive.syncProfileUp(googleClientId, uid_, profileData);
        const ts = new Date().toLocaleTimeString();
        setGdriveStatus(`✅ Synced at ${ts}`);
        setLastSyncedAt(ts);
        localStorage.setItem("fm_last_synced", ts);
      } catch (e) {
        console.warn("[FM6] Auto-sync failed:", e.message);
        setGdriveStatus("⚠️ Sync failed – will retry");
      } finally {
        setGdriveSyncing(false);
      }
    }, 4000);
    return () => clearTimeout(autoSyncTimer.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    uid_,
    // Watch lengths AND a content-change signal for flash progress so that
    // rating an already-seen card (no length change) still triggers a sync.
    subjects.length, topics.length, subtopics.length, questions.length,
    flashProg.length, quizAttempts.length, reviewHistory.length, profiles.length,
    // Derived: last review timestamp acts as a "something changed" sentinel
    flashProg[flashProg.length - 1]?.lastReview,
    reviewHistory[reviewHistory.length - 1]?.timestamp,
  ]);

  // ── Google Drive: manual push (for Settings panel) ────────
  useEffect(() => {
    if (!googleUser || !googleClientId) return;

    const pullLatest = () => {
      // Never attempt a Drive pull when the access token is expired — doing so
      // creates a new GIS token-client instance that can surface the consent
      // popup unexpectedly ("looping signin").
      if (document.visibilityState === "hidden" || !GDrive.hasValidToken()) return;
      restoreDriveProfiles("", "merge").catch(e => {
        console.warn("[FM6] Background Drive pull failed:", e.message);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") pullLatest();
    };

    pullLatest();
    const intervalId = window.setInterval(pullLatest, 30000);
    window.addEventListener("focus", pullLatest);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener("focus", pullLatest);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [googleUser, googleClientId, restoreDriveProfiles]);

  useEffect(() => {
    if (!googleUser || !googleClientId) return;

    const refreshLocks = () => {
      // Same guard — skip when token is expired.
      if (document.visibilityState === "hidden" || !GDrive.hasValidToken()) return;
      refreshProfileLocks().catch(e => {
        console.warn("[FM6] Background lock refresh failed:", e.message);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshLocks();
    };

    refreshLocks();
    const intervalId = window.setInterval(refreshLocks, PROFILE_LOCK_HEARTBEAT_MS);
    window.addEventListener("focus", refreshLocks);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener("focus", refreshLocks);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [googleUser, googleClientId, refreshProfileLocks]);

  useEffect(() => {
    if (!currentProfile) return;
    const lock = profileLocks[currentProfile.id];
    if (!lock || !isProfileLockActive(lock) || lock.deviceId === deviceId) return;

    stopProfileLockHeartbeat();
    activeProfileLockRef.current = null;
    setCP(null);
    navigate("profiles");
    showToast(`${currentProfile.name} is active on another device`, "error");
  }, [currentProfile, deviceId, navigate, profileLocks, showToast, stopProfileLockHeartbeat]);

  async function syncProfileToDrive() {
    if (!googleUser) { showToast("Sign in to Google first!", "error"); return; }
    if (!googleClientId) { showToast("Google OAuth is not configured", "error"); return; }
    if (!uid_) { showToast("Select a profile first", "error"); return; }
    // Trigger immediately by clearing debounce timer and running now
    if (autoSyncTimer.current) clearTimeout(autoSyncTimer.current);
    setGdriveSyncing(true);
    setGdriveStatus("Syncing…");
    try {
      const data = await DB.exportAll();
      const profileData = buildProfileSyncData(data, uid_);
      await GDrive.syncProfileUp(googleClientId, uid_, profileData);
      const ts = new Date().toLocaleTimeString();
      setGdriveStatus(`✅ Synced at ${ts}`);
      setLastSyncedAt(ts);
      localStorage.setItem("fm_last_synced", ts);
      showToast("Profile synced to Google Drive! ✅");
    } catch (e) {
      setGdriveStatus("❌ Sync failed: " + e.message);
      showToast("Drive sync failed: " + e.message, "error");
    } finally {
      setGdriveSyncing(false);
    }
  }

  // ── Google Drive: Pull all profiles ───────────────────────
  async function restoreFromDrive() {
    if (!googleUser) { showToast("Sign in to Google first!", "error"); return; }
    if (!googleClientId) { showToast("Google OAuth is not configured", "error"); return; }
    setGdriveSyncing(true);
    setGdriveStatus("Downloading from Drive…");
    try {
      await releaseProfileLock(currentProfile?.id);
      const imported = await restoreDriveProfiles("Downloading from Drive…", "replace");
      if (!imported) { showToast("No profile backups found in Drive", "info"); setGdriveStatus(""); return; }
      setCP(null); navigate("profiles");
      setGdriveStatus(`✅ Restored ${imported} profile(s) from Drive`);
      showToast(`Restored ${imported} profile(s) from Drive! ✅`);
    } catch (e) {
      setGdriveStatus("❌ Restore failed: " + e.message);
      showToast("Drive restore failed: " + e.message, "error");
    } finally {
      setGdriveSyncing(false);
    }
  }

  // ── Backup / Restore ───────────────────────────────────────
  async function exportBackup() {
    const data = await DB.exportAll();
    let payload = JSON.stringify(data, null, 2);
    if (settings.encryptBackup && settings.encryptPassword) {
      const enc = await Crypto.encrypt(data, settings.encryptPassword);
      payload = JSON.stringify({ encrypted: true, payload: enc });
    }
    const blob = new Blob([payload], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `flashmaster_v6_${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast("Backup exported!");
  }

  async function importBackup(jsonText) {
    try {
      let data = JSON.parse(jsonText);
      if (data.encrypted && data.payload) {
        const pwd = prompt("Enter backup password:");
        if (!pwd) return;
        data = await Crypto.decrypt(data.payload, pwd);
        if (!data) { showToast("Wrong password or corrupt backup", "error"); return; }
      }
      if (!data.profiles || !data.questions) throw new Error("Invalid backup format");
      await DB.importAll(data);
      // Reload
      const db = await getDB();
      const [p, allS, allT, allST, allQ, allFP, allQA, allLB, allRH] = await Promise.all([
        db.profiles.toArray(), db.subjects.toArray(), db.topics.toArray(),
        db.subtopics.toArray(), db.questions.toArray(), db.flashProgress.toArray(),
        db.quizAttempts.toArray(), db.leaderboard.toArray(), db.reviewHistory.toArray(),
      ]);
      setProfiles(p); setSubjects(allS); setTopics(allT); setSubtopics(allST);
      setQuestions(allQ); setFlashProg(allFP); setQA(allQA); setLB(allLB); setRH(allRH);
      setCP(null); navigate("profiles");
      showToast("Backup restored!");
    } catch(e) { showToast("Import failed: " + e.message, "error"); }
  }

  async function resetAllStats() {
    const db = await getDB();
    await Promise.all([
      db.flashProgress.where("uid").equals(uid_).delete(),
      db.quizAttempts.where("uid").equals(uid_).delete(),
      db.reviewHistory.where("uid").equals(uid_).delete(),
      DB.clearSessionDraft(uid_),
    ]);
    setFlashProg(p => p.filter(f => f.uid !== uid_));
    setQA(p => p.filter(a => a.uid !== uid_));
    setRH(p => p.filter(r => r.uid !== uid_));
    const z = { count: 0, lastDate: null };
    setStreak(z); localStorage.setItem("fm_streak", JSON.stringify(z));
    const zd = { date: null, flash: 0, quiz: 0 };
    setDaily(zd); localStorage.setItem("fm_daily", JSON.stringify(zd));
    showToast("Stats reset!");
  }

  const value = {
    dbReady, profiles, subjects: userSubjects, topics, subtopics, questions,
    flashProg: userProgress, quizAttempts: userQA, leaderboard, reviewHistory: userRH,
    settings, streak, daily, dailyPlan,
    currentProfile, setCurrentProfile: setCP,
    screen, navigate, nav, toast,
    focusMode, setFocusMode, pwaPrompt,
    progMap, questionMap, subtopicMap, topicMap, subjectMap,
    createProfile, deleteProfile, createSubject, deleteSubject,
    createTopic, deleteTopic, createSubtopic, deleteSubtopic,
    importCSVToSubject, addQuestion, deleteQuestion,
    applyRating, resetSubtopicProgress,
    saveSessionDraft, loadSessionDraft, clearSessionDraft,
    saveQuizAttempt, saveSettings, resetAllStats, exportBackup, importBackup,
    getAccuracy, getWeakLessons, selectAdaptive, getTodayDP, showToast,
    // Google / Drive
    googleUser, googleClientId, googleAuthChecking, gdriveSyncing, gdriveStatus, lastSyncedAt,
    deviceId, deviceLabel, profileLocks,
    googleSignIn, googleSignOut, googleSwitchAccount, checkGoogleSignInStatus,
    enterProfile,
    syncProfileToDrive, restoreFromDrive,
    SRS, ReviewQueue, CSV, Speech, Crypto,
  };

  if (!dbReady) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#060A16", color:"#E2E8F0", fontFamily:"sans-serif", flexDirection:"column", gap:16 }}>
      <div style={{ fontSize:52 }}>⚡</div>
      <div style={{ fontWeight:800, fontSize:20, letterSpacing:-0.5 }}>FlashMaster v6</div>
      <div style={{ color:"#5A6882", fontSize:14 }}>Opening Dexie database…</div>
    </div>
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ══════════════════════════════════════════════════════════════
// §10  VIRTUALIZED LIST — handles 100k+ rows without lag
// ══════════════════════════════════════════════════════════════
function VirtualList({ items, renderItem, itemHeight = 72, containerHeight = 480 }) {
  const [scrollTop, setScrollTop] = useState(0);
  const visibleCount = Math.ceil(containerHeight / itemHeight) + 2;
  const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - 1);
  const endIdx   = Math.min(items.length, startIdx + visibleCount);
  const totalHeight = items.length * itemHeight;

  return (
    <div
      style={{ height: containerHeight, overflowY: "auto", position: "relative" }}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {items.slice(startIdx, endIdx).map((item, i) => (
          <div key={item.id || startIdx + i}
            style={{ position: "absolute", top: (startIdx + i) * itemHeight, left: 0, right: 0, height: itemHeight }}>
            {renderItem(item, startIdx + i)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §11  DYNAMIC QUESTION RENDERER — per type
// ══════════════════════════════════════════════════════════════
function MatchQuestion({ question, onAnswer, checked }) {
  const pairs = useMemo(() => (question.options || "").split(",").map(p => {
    const [l, r] = p.split(":").map(s => s.trim());
    return { left: l || "", right: r || "" };
  }).filter(p => p.left && p.right), [question.options]);
  const rights  = useMemo(() => shuffle(pairs.map(p => p.right)), [pairs]);
  const [matched, setMatched] = useState({});
  const [dragging, setDragging] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  function drop(right) {
    if (!dragging || checked) return;
    const nm = Object.fromEntries(Object.entries(matched).filter(([l]) => l !== dragging));
    Object.entries(nm).forEach(([l, r]) => { if (r === right) delete nm[l]; });
    nm[dragging] = right;
    setMatched(nm);
    if (Object.keys(nm).length === pairs.length)
      onAnswer(pairs.map(p => `${p.left}:${nm[p.left] || ""}`).join(","));
    setDragging(null); setDragOver(null);
  }

  return (
    <div>
      <div style={{ fontSize:12, color:"var(--muted)", fontWeight:700, marginBottom:10 }}>Drag to match ↔</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {pairs.map(({ left }) => {
            const mr  = matched[left];
            const ok  = checked && pairs.find(p => p.left === left)?.right === mr;
            const bad = checked && mr && !ok;
            return (
              <div key={left} draggable={!checked}
                onDragStart={() => setDragging(left)} onDragEnd={() => { setDragging(null); setDragOver(null); }}
                className={`match-term ${checked ? (ok ? "correct" : bad ? "wrong" : "") : ""} ${dragging === left ? "dragging" : ""}`}>
                <span className="drag-handle">⠿</span>
                <span style={{ flex:1 }}>{left}</span>
                {mr && <span style={{ fontSize:11, color:"var(--primary)" }}>→ {mr}</span>}
              </div>
            );
          })}
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {rights.map(right => (
            <div key={right}
              onDragOver={e => { e.preventDefault(); setDragOver(right); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={() => drop(right)}
              className={`match-target ${dragOver === right ? "drag-over" : ""} ${Object.values(matched).includes(right) ? "used" : ""}`}>
              {right}
            </div>
          ))}
        </div>
      </div>
      {checked && <div style={{ marginTop:10 }}>{pairs.map(p => <div key={p.left} style={{ fontSize:12, color:"var(--green)", marginBottom:2 }}>{p.left} → {p.right}</div>)}</div>}
    </div>
  );
}

function OrderQuestion({ question, onAnswer, checked }) {
  const correct = useMemo(() => (question.answer || "").split(",").map(s => s.trim()), [question.answer]);
  const [order, setOrder]     = useState(() => shuffle((question.options || question.answer || "").split(",").map(s => s.trim()).filter(Boolean)));
  const [dragging, setDragging] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  useEffect(() => { onAnswer(order.join(",")); }, [order, onAnswer]);

  function drop(ti) {
    if (dragging === null || checked) return;
    const o = [...order];
    const [m] = o.splice(dragging, 1);
    o.splice(ti, 0, m);
    setOrder(o); setDragging(null); setDragOver(null);
  }

  return (
    <div>
      <div style={{ fontSize:12, color:"var(--muted)", fontWeight:700, marginBottom:10 }}>Drag into correct order:</div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {order.map((item, i) => {
          const ok = checked && correct[i] === item;
          return (
            <div key={`${item}-${i}`} draggable={!checked}
              onDragStart={() => setDragging(i)} onDragEnd={() => { setDragging(null); setDragOver(null); }}
              onDragOver={e => { e.preventDefault(); setDragOver(i); }}
              onDragLeave={() => setDragOver(null)} onDrop={() => drop(i)}
              className={`order-item ${dragging === i ? "dragging" : ""} ${dragOver === i ? "drag-over" : ""} ${checked ? (ok ? "correct" : "wrong") : ""}`}>
              <span className="order-num">{i + 1}</span>
              <span className="drag-handle">⠿</span>
              <span style={{ flex:1 }}>{item}</span>
              {checked && (ok ? <span style={{ color:"var(--green)" }}>✓</span> : <span style={{ color:"var(--muted)", fontSize:11 }}>→ {correct[i]}</span>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ClozeQuestion({ question, onAnswer, checked }) {
  const [inputs, setInputs] = useState({});
  const parts   = (question.question_text || "").split("___");
  const blanks  = parts.length - 1;
  const answers = (question.answer || "").split(",").map(s => s.trim());

  function setInput(i, v) {
    const u = { ...inputs, [i]: v };
    setInputs(u);
    onAnswer(Array.from({ length: blanks }, (_, k) => u[k] || "").join(","));
  }

  return (
    <div style={{ fontFamily:"var(--syne)", fontWeight:700, fontSize:18, lineHeight:2.5 }}>
      {parts.map((part, i) => (
        <span key={i}>{part}
          {i < parts.length - 1 && (
            <span style={{ position:"relative", display:"inline-block", margin:"0 6px" }}>
              <input className={`cloze-input ${checked ? (inputs[i]?.trim().toLowerCase() === answers[i]?.toLowerCase() ? "correct" : "wrong") : ""}`}
                value={inputs[i] || ""} onChange={e => setInput(i, e.target.value)}
                disabled={checked} placeholder="___" size={Math.max(6, (answers[i] || "").length)} />
              {checked && inputs[i]?.trim().toLowerCase() !== answers[i]?.toLowerCase() && (
                <span style={{ position:"absolute", top:"100%", left:0, fontSize:11, color:"var(--green)", whiteSpace:"nowrap" }}>→ {answers[i]}</span>
              )}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Universal QuestionRenderer — dispatches to correct component by type
 */
function QuestionRenderer({ question, userAnswer, onAnswer, checked, reverseMode, ttsLang, ttsRate, showExplanation, showHint }) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const { settings } = useApp();

  useEffect(() => { setText(""); }, [question.id, question.answerTypeKey, question.answer]);

  const q = reverseMode
    ? { ...question, question_text: `Answer: "${question.answer}"`, answer: question.question_text, type:"FillBlank", options:"", answerTypeKey:"answer", answerTypeLabel:"Answer" }
    : question;

  const opts = (q.options || "").split(",").map(s => s.trim()).filter(Boolean);
  const effectiveType = opts.length < 2 && ["MCQ","MultiSelect"].includes(q.type) ? "FillBlank" : q.type;
  const missingInteractiveOptions = !reverseMode && (
    (["MCQ","MultiSelect"].includes(q.type) && opts.length < 2) ||
    (q.type === "Match" && opts.length < 1)
  );

  function handleText(val) { setText(val); onAnswer(val); }
  function startListen() {
    setListening(true);
    Speech.listen((t, c) => { handleText(t); setListening(false); }, () => setListening(false), ttsLang || "en-US");
  }

  if (missingInteractiveOptions) {
    return (
      <div style={{ background:"var(--accent)10", border:"1px solid var(--accent)30", borderRadius:12, padding:"12px 14px", fontSize:13, color:"var(--accent)" }}>
        This {q.type} question is missing an <code>options</code> value in the imported data. Re-import it with an <code>options</code> column to use the interactive quiz layout.
      </div>
    );
  }

  // MCQ
  if (effectiveType === "MCQ") return (
    <div>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {opts.map(opt => {
          let cls = "quiz-opt";
          if (checked) { cls += opt.toLowerCase() === q.answer.toLowerCase() ? " correct" : userAnswer === opt ? " wrong" : ""; }
          else if (userAnswer === opt) cls += " selected";
          return <button key={opt} className={cls} onClick={() => !checked && onAnswer(opt)} disabled={checked}>{opt}</button>;
        })}
      </div>
      {renderExplanation(q, checked, showExplanation)}
    </div>
  );

  // TrueFalse
  if (effectiveType === "TrueFalse") return (
    <div>
      <div style={{ display:"flex", gap:14 }}>
        {["True","False"].map(opt => {
          let cls = "quiz-opt tf-opt";
          if (checked) { cls += opt.toLowerCase() === q.answer.toLowerCase() ? " correct" : userAnswer === opt ? " wrong" : ""; }
          else if (userAnswer === opt) cls += " selected";
          return <button key={opt} className={cls} style={{ flex:1, fontSize:18, padding:"20px 0" }} onClick={() => !checked && onAnswer(opt)} disabled={checked}>{opt === "True" ? "✓ True" : "✗ False"}</button>;
        })}
      </div>
      {renderExplanation(q, checked, showExplanation)}
    </div>
  );

  // MultiSelect
  if (effectiveType === "MultiSelect") {
    const sel  = userAnswer ? userAnswer.split(",").map(s => s.trim()) : [];
    const corr = new Set(q.answer.split(",").map(s => s.trim().toLowerCase()));
    return (
      <div>
        <div style={{ fontSize:12, color:"var(--muted)", fontWeight:700, marginBottom:10 }}>Select all that apply:</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {opts.map(opt => {
            const isSel = sel.includes(opt);
            let cls = "quiz-opt";
            if (checked) {
              if (corr.has(opt.toLowerCase()) && isSel) cls += " correct";
              else if (corr.has(opt.toLowerCase())) cls += " correct-missed";
              else if (isSel) cls += " wrong";
            } else if (isSel) cls += " selected";
            return <button key={opt} className={cls}
              onClick={() => { if (checked) return; const u = isSel ? sel.filter(s => s !== opt) : [...sel, opt]; onAnswer(u.join(",")); }}
              disabled={checked}>
              <span style={{ marginRight:10, opacity:.7 }}>{isSel ? "☑" : "☐"}</span>{opt}
            </button>;
          })}
        </div>
        {renderExplanation(q, checked, showExplanation)}
      </div>
    );
  }

  // Match
  if (effectiveType === "Match") return <><MatchQuestion question={q} onAnswer={onAnswer} checked={checked} />{renderExplanation(q, checked, showExplanation)}</>;

  // Order
  if (effectiveType === "Order") return <><OrderQuestion question={q} onAnswer={onAnswer} checked={checked} />{renderExplanation(q, checked, showExplanation)}</>;

  // Cloze
  if (effectiveType === "Cloze") return <><ClozeQuestion question={q} onAnswer={onAnswer} checked={checked} />{renderExplanation(q, checked, showExplanation)}</>;

  // FillBlank / Dictation / Image / Audio
  return (
    <div>
      {effectiveType === "Dictation" && <button className="btn btn-accent" style={{ width:"100%", marginBottom:12, padding:16 }} onClick={() => Speech.speak(q.answer, ttsLang, ttsRate)}>🔊 Listen — type what you hear</button>}
      {["Image","Audio"].includes(effectiveType) && <QuestionMedia question={q} />}
      {showHint && !checked && <div style={{ fontSize:13, color:"var(--accent)", fontWeight:700, marginBottom:8 }}>💡 Starts with: {q.answer[0]?.toUpperCase()}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <input className={`input ${checked ? (text.trim().toLowerCase().replace(/[.,!?]/g,"") === q.answer.trim().toLowerCase().replace(/[.,!?]/g,"") ? "input-correct" : "input-wrong") : ""}`}
          placeholder={getAnswerPlaceholder(effectiveType, q.answerTypeLabel)} value={text}
          onChange={e => handleText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && text && onAnswer(text)}
          disabled={checked} autoFocus />
        <button className={`btn btn-ghost btn-sm ${listening ? "pulsing" : ""}`} onClick={startListen} title="🎤 Voice">🎤</button>
      </div>
      {renderExplanation(q, checked, showExplanation)}
    </div>
  );
}

function renderExplanation(q, checked, show) {
  if (!show || !checked || !q.explanation) return null;
  return (
    <div style={{ marginTop:12, background:"#6366F112", border:"1px solid #6366F130", borderRadius:10, padding:"10px 14px" }}>
      <div style={{ fontWeight:700, fontSize:13, color:"var(--primary)", marginBottom:4 }}>💡 Explanation</div>
      <div style={{ fontSize:13, color:"var(--text)", lineHeight:1.6 }}>{q.explanation}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §12  UI PRIMITIVES
// ══════════════════════════════════════════════════════════════
function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: wide ? 740 : 500 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
          <div className="h2">{title}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PBar({ value, max, height = 6, color = "" }) {
  const pct = max > 0 ? Math.min(100, value / max * 100) : 0;
  return (
    <div className="pbar"><div className={`pbar-fill ${color}`} style={{ width:`${pct}%` }} /></div>
  );
}

function Toast({ msg, type }) {
  const cols = { success:"var(--green)", error:"var(--red)", info:"var(--primary)", warn:"var(--accent)" };
  return <div style={{ position:"fixed", bottom:28, right:28, zIndex:9999, background:cols[type]||cols.success, color:"white", padding:"11px 20px", borderRadius:14, fontWeight:700, fontSize:14, boxShadow:"0 8px 32px rgba(0,0,0,.5)", animation:"slideUp .22s", maxWidth:340 }}>{msg}</div>;
}

function Badge({ children, v = "primary" }) {
  return <span className={`badge badge-${v}`}>{children}</span>;
}

function Empty({ icon, title, sub, action }) {
  return (
    <div style={{ textAlign:"center", padding:"52px 16px", color:"var(--muted)" }}>
      <div style={{ fontSize:48, marginBottom:12 }}>{icon}</div>
      <div className="h2" style={{ color:"var(--text)", marginBottom:8 }}>{title}</div>
      {sub && <div style={{ fontSize:14, marginBottom:20, maxWidth:300, margin:"0 auto 20px" }}>{sub}</div>}
      {action}
    </div>
  );
}

function GoalRing({ done, goal, label, icon, color = "var(--primary)" }) {
  const pct  = goal > 0 ? Math.min(100, done / goal * 100) : 0;
  const r    = 22; const circ = 2 * Math.PI * r;
  const dash = pct / 100 * circ;
  const met  = done >= goal;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:12, background:"var(--surface)", borderRadius:12, padding:"12px 16px", border:`1px solid ${met ? color : "var(--border)"}`, flex:1, minWidth:0 }}>
      <div style={{ position:"relative", width:52, height:52, flexShrink:0 }}>
        <svg width="52" height="52" style={{ transform:"rotate(-90deg)" }}>
          <circle cx="26" cy="26" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
          <circle cx="26" cy="26" r={r} fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition:"stroke-dasharray .5s" }} />
        </svg>
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>{icon}</div>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontFamily:"var(--syne)", fontWeight:800, fontSize:18, color:met ? color : "var(--text)" }}>{done}<span style={{ fontWeight:400, color:"var(--muted)", fontSize:13 }}>/{goal}</span></div>
        <div style={{ fontSize:12, color:"var(--muted)", fontWeight:600, marginTop:1 }}>{label}</div>
        {met && <div style={{ fontSize:11, color, fontWeight:700 }}>✓ Goal hit!</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §13  SWIPE CARD
// ══════════════════════════════════════════════════════════════
function SwipeCard({ children, onLeft, onRight, enabled }) {
  const startX = useRef(0);
  const [dx, setDx] = useState(0);
  const [active, setActive] = useState(false);
  const THRESH = 80;

  function start(x) { if (!enabled) return; startX.current = x; setActive(true); }
  function move(x)  { if (!active || !enabled) return; setDx(x - startX.current); }
  function end(x) {
    if (!active || !enabled) return;
    const d = x - startX.current;
    setActive(false); setDx(0);
    if (d < -THRESH) { haptic("medium"); onLeft?.(); }
    else if (d > THRESH) { haptic("medium"); onRight?.(); }
  }

  return (
    <div
      style={{ transform:`translateX(${dx}px) rotate(${dx * 0.05}deg)`, transition:active?"none":"transform .3s", userSelect:"none" }}
      onMouseDown={e => start(e.clientX)} onMouseMove={e => move(e.clientX)} onMouseUp={e => end(e.clientX)} onMouseLeave={e => end(e.clientX)}
      onTouchStart={e => start(e.touches[0].clientX)} onTouchMove={e => move(e.touches[0].clientX)} onTouchEnd={e => end(e.changedTouches[0].clientX)}
    >
      {enabled && active && Math.abs(dx) > 20 && (
        <div style={{ position:"absolute", top:14, zIndex:10, ...(dx > 20 ? { right:14, color:"var(--green)" } : { left:14, color:"var(--red)" }), fontFamily:"var(--syne)", fontWeight:900, fontSize:20, opacity:Math.min(Math.abs(dx) / THRESH, 1) }}>
          {dx > 20 ? "✓ Good" : "✗ Again"}
        </div>
      )}
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §14  REPEAT-AFTER-ME
// ══════════════════════════════════════════════════════════════
function RepeatAfterMe({ text, lang, tolerance }) {
  const [phase, setPhase]   = useState("idle");
  const [result, setResult] = useState(null);

  function play()   { setPhase("playing"); Speech.speak(text, lang, 0.85, () => setPhase("idle")); }
  function listen() {
    setPhase("listening");
    Speech.listen((spoken, conf) => {
      const r = Speech.scorePronunciation(spoken, text, tolerance);
      setResult({ ...r }); setPhase("result");
    }, () => { if (phase === "listening") setPhase("idle"); }, lang);
  }

  return (
    <div style={{ background:"#6366F108", border:"1px solid #6366F130", borderRadius:12, padding:14, marginTop:12 }}>
      <div style={{ fontWeight:700, fontSize:13, color:"var(--primary)", marginBottom:8 }}>🎙️ Repeat After Me</div>
      <div style={{ fontFamily:"var(--syne)", fontWeight:700, fontSize:15, marginBottom:10 }}>{text}</div>
      <div style={{ display:"flex", gap:8 }}>
        <button className="btn btn-ghost btn-sm" onClick={play} disabled={phase !== "idle" && phase !== "result"}>🔊 Hear</button>
        <button className="btn btn-primary btn-sm" onClick={listen} disabled={phase === "listening" || phase === "playing"}>
          {phase === "listening" ? "🎤 Listening…" : "🎤 Repeat"}
        </button>
        {result && <button className="btn btn-ghost btn-sm" onClick={() => { setResult(null); setPhase("idle"); }}>↩</button>}
      </div>
      {result && (
        <div style={{ marginTop:10, background:result.pass ? "#10B98112" : "#EF444412", borderRadius:8, padding:"8px 12px" }}>
          <div style={{ fontWeight:800, color:result.pass ? "var(--green)" : "var(--red)" }}>{result.feedback}</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:3 }}>You said: "{result.spoken}"</div>
          <PBar value={result.score} max={100} height={5} color={result.score >= 80 ? "green" : result.score >= 60 ? "accent" : ""} />
          <div style={{ fontSize:11, fontWeight:700, color:result.pass ? "var(--green)" : "var(--red)", marginTop:4 }}>{result.score}%</div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §15  FLASH SCREEN — SM-2, Review Queue, Resume, Skip, Mark
// ══════════════════════════════════════════════════════════════
const RATINGS = [
  { key:"again", label:"Again", sub:"<1d",   icon:"↩", color:"var(--red)",     k:"1" },
  { key:"hard",  label:"Hard",  sub:"+1.2x", icon:"😓", color:"var(--accent)",  k:"2" },
  { key:"good",  label:"Good",  sub:"next",  icon:"👍", color:"var(--primary)", k:"3" },
  { key:"easy",  label:"Easy",  sub:"skip",  icon:"⚡", color:"var(--green)",   k:"4" },
];

function FlashScreen() {
  const { subtopics, questions, settings, currentProfile, applyRating, progMap, focusMode, setFocusMode, navigate, nav, saveSessionDraft, clearSessionDraft, loadSessionDraft, showToast, ReviewQueue, SRS } = useApp();
  const uid_ = currentProfile?.id;

  // ── Build raw pool ─────────────────────────────────────────
  const rawQs = useMemo(() => {
    if (nav.preloadedQs) return nav.preloadedQs;
    if (nav.subtopicId)  return questions.filter(q => q.stid === nav.subtopicId);
    return [];
  }, [nav, questions]);

  // ── Build review queue deck ────────────────────────────────
  const rq = useMemo(() => ReviewQueue.build(rawQs, progMap, settings.deckLimit || 50), [rawQs, progMap, settings.deckLimit]);

  const [deck,        setDeck]        = useState(() => rq.deck);
  const [idx,         setIdx]         = useState(0);
  const [rep,         setRep]         = useState(1);
  const [flipped,     setFlipped]     = useState(false);
  const [userAnswer,  setUserAnswer]  = useState("");
  const [checked,     setChecked]     = useState(false);
  const [isCorrect, setIsCorrect]     = useState(null); //4.2.1
  const [skipped,     setSkipped]     = useState([]);
  const [marked,      setMarked]      = useState([]);
  const [reverseMode, setReverse]     = useState(nav.reverseMode || false);
  const [showHint,    setShowHint]    = useState(false);
  const [showRepeat,  setShowRepeat]  = useState(false);
  const [sessionStats,setSS]          = useState({ again:0, hard:0, good:0, easy:0, skipped:0 });
  const [startTime]                   = useState(Date.now());
  const [sessionStart]                = useState(performance.now());
  const cardStartRef                  = useRef(performance.now());
  const totalReps = settings.repetitionCount || 3;
  const current   = deck[idx];
  const isDone    = idx >= deck.length;
  const studyCurrent = useMemo(() => prepareQuestionForStudy(current, "", `${idx}-${rep}`), [current, idx, rep]);
  const questionPrompt = getQuestionLabel(studyCurrent);

  // Resume from draft
  useEffect(() => {
    (async () => {
      const draft = await loadSessionDraft();
      if (draft && draft.subtopicId === nav.subtopicId && draft.idx < deck.length) {
        const resume = window.confirm(`Resume previous session from card ${draft.idx + 1}/${deck.length}?`);
        if (resume) {
          setIdx(draft.idx);
          setSS(draft.sessionStats || {});
        }
      }
    })();
  }, []);

  // Save draft periodically
  useEffect(() => {
    const t = setInterval(() => {
      if (!isDone && current) {
        saveSessionDraft({
          subtopicId: nav.subtopicId, idx, sessionStats,
          rep, elapsedMs: Date.now() - startTime,
        });
      }
    }, 10_000);
    return () => clearInterval(t);
  }, [idx, sessionStats, rep, saveSessionDraft]);

  // TTS
  useEffect(() => {
    if (!studyCurrent || !settings.autoTTS || isDone) return;
    const t = setTimeout(() => Speech.speak(reverseMode ? studyCurrent.answer : questionPrompt, settings.ttsLang, settings.ttsRate), 300);
    return () => { clearTimeout(t); Speech.cancel(); };
  }, [idx, reverseMode, rep, settings.autoTTS]);

  // Keyboard
  useEffect(() => {
    const h = e => {
      if (["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return;
      if (e.code === "Space")  { e.preventDefault(); setFlipped(f => !f); }
      if (e.code === "KeyH")   setShowHint(h => !h);
      if (e.code === "KeyR")   setReverse(r => !r);
      if (e.code === "KeyF")   setFocusMode(f => !f);
      if (e.code === "KeyS")   skip();
      if (e.code === "KeyM")   markDifficult();
      if (flipped || checked) {
        if (e.code === "Digit1") rate("again");
        if (e.code === "Digit2") rate("hard");
        if (e.code === "Digit3") rate("good");
        if (e.code === "Digit4") rate("easy");
        // (keyboard handler correctly calls rate with string literals)
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [flipped, checked, idx, skip, markDifficult]);

  function skip() {
    if (isDone || !current) return;
    setSkipped(s => [...s, current.id]);
    setSS(s => ({ ...s, skipped: s.skipped + 1 }));
    const nd = [...deck]; nd.push(nd.splice(idx, 1)[0]);
    setDeck(nd); reset();
  }

  function markDifficult() {
    if (!current) return;
    const wasMarked = marked.includes(current.id);
    setMarked(m => wasMarked ? m.filter(x => x !== current.id) : [...m, current.id]);
    showToast(wasMarked ? "Mark removed" : "Marked as difficult ⚑", "info");
  }

  async function rate(rating) {
    const responseMs = performance.now() - cardStartRef.current;
    await applyRating(current.id, rating, Math.round(responseMs));
    setSS(s => ({ ...s, [rating]: s[rating] + 1 }));
    Speech.cancel();
    const nextIdx = idx + 1;
    if (nextIdx >= deck.length) {
      if (rep < totalReps) {
        setRep(prev => prev + 1);
        setDeck(SRS.prioritize(rawQs, progMap));
        setIdx(0);
      } else { setIdx(nextIdx); }
    } else { setIdx(nextIdx); }
    reset();
  }

  function reset() {
    setFlipped(false); setUserAnswer(""); setChecked(false);
    setIsCorrect(null);
    setShowHint(false); setShowRepeat(false);
    cardStartRef.current = performance.now();
  }

  if (rawQs.length === 0) return (
    <Empty icon="📭" title="No cards to study" sub="Add questions or come back when cards are due"
      action={<button className="btn btn-primary btn-lg" onClick={() => navigate("subtopics")}>Go Back</button>} />
  );

  if (isDone) {
    clearSessionDraft();
    const total = Object.entries(sessionStats).filter(([k]) => k !== "skipped").reduce((a, [, v]) => a + v, 0);
    const goodPct = total > 0 ? Math.round((sessionStats.good + sessionStats.easy) / total * 100) : 0;
    return (
      <div style={{ textAlign:"center", padding:"48px 16px", maxWidth:540, margin:"0 auto" }}>
        <div style={{ fontSize:72 }}>{goodPct >= 80 ? "🏆" : goodPct >= 60 ? "🎉" : "💪"}</div>
        <div className="h1" style={{ marginTop:14, color:"var(--green)" }}>Session Complete!</div>
        <div style={{ color:"var(--muted)", marginTop:6 }}>Round {rep} · {Math.round((Date.now()-startTime)/60000)} min</div>
        <div className="card" style={{ margin:"22px auto", padding:22, maxWidth:380 }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:10 }}>
            {[{key:"again",icon:"↩",color:"var(--red)"},{key:"hard",icon:"😓",color:"var(--accent)"},{key:"good",icon:"👍",color:"var(--primary)"},{key:"easy",icon:"⚡",color:"var(--green)"},{key:"skipped",icon:"⏭",color:"var(--muted)"}].map(r => (
              <div key={r.key} style={{ textAlign:"center" }}>
                <div style={{ fontSize:20 }}>{r.icon}</div>
                <div style={{ fontFamily:"var(--syne)", fontWeight:800, fontSize:22, color:r.color }}>{sessionStats[r.key] || 0}</div>
                <div style={{ fontSize:10, color:"var(--muted)" }}>{r.key}</div>
              </div>
            ))}
          </div>
          {marked.length > 0 && <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid var(--border)", fontSize:13, color:"var(--accent)" }}>⚑ {marked.length} marked as difficult</div>}
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
          {marked.length > 0 && <button className="btn btn-accent btn-lg" onClick={() => { setDeck(rawQs.filter(q => marked.includes(q.id))); setIdx(0); setRep(1); setSS({again:0,hard:0,good:0,easy:0,skipped:0}); }}>⚑ Review Marked ({marked.length})</button>}
          <button className="btn btn-ghost btn-lg" onClick={() => { setDeck(SRS.prioritize(rawQs, progMap)); setIdx(0); setRep(1); setSS({again:0,hard:0,good:0,easy:0,skipped:0}); setMarked([]); }}>🔄 Restart</button>
          <button className="btn btn-primary btn-lg" onClick={() => navigate("subtopics")}>✓ Done</button>
        </div>
      </div>
    );
  }

  if (!current || !studyCurrent) return null;
  const prog      = progMap.get(current.id);
  const retention = prog ? SRS.retention(prog) : null;
  const qLabel    = SRS.queueLabel(prog);
  const isMarked  = marked.includes(current.id);

  return (
    <div style={{ maxWidth:740, margin:"0 auto" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, flexWrap:"wrap", gap:8 }}>
        <div style={{ fontSize:13, color:"var(--muted)" }}>
          Round {rep}/{totalReps} · Card {idx+1}/{deck.length}
          {" "}<span style={{ fontWeight:700, color:qLabel === "Due" ? "var(--accent)" : qLabel === "New" ? "var(--primary)" : qLabel === "Mastered" ? "var(--green)" : "var(--muted)" }}>[{qLabel}]</span>
        </div>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          {retention !== null && <span style={{ fontSize:11, background:"var(--surface)", padding:"3px 8px", borderRadius:6, fontWeight:700, color:retention > 70 ? "var(--green)" : retention > 40 ? "var(--accent)" : "var(--red)" }}>⏳ {retention}%</span>}
          {prog && <span style={{ fontSize:11, background:"var(--surface)", padding:"3px 8px", borderRadius:6, color:"var(--muted)" }}>Box {prog.box || 0}</span>}
          <button className={`btn btn-ghost btn-sm ${isMarked ? "active-mode" : ""}`} onClick={markDifficult} title="M — Mark">⚑</button>
          <button className="btn btn-ghost btn-sm" onClick={skip} title="S — Skip">⏭</button>
          <button className={`btn btn-ghost btn-sm ${reverseMode ? "active-mode" : ""}`} onClick={() => setReverse(r => !r)} title="R — Reverse">🔄</button>
          <button className={`btn btn-ghost btn-sm ${showHint ? "active-mode" : ""}`} onClick={() => setShowHint(h => !h)} title="H — Hint">💡</button>
          <button className={`btn btn-ghost btn-sm ${focusMode ? "active-mode" : ""}`} onClick={() => setFocusMode(f => !f)} title="F — Focus">🎯</button>
        </div>
      </div>

      <PBar value={idx} max={deck.length} height={5} />
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"var(--muted)", marginTop:4, marginBottom:16 }}>
        <div>{rq.newCount} new · {rq.dueCount} due · {rq.learningCount} learning · {rq.masteredCount} mastered</div>
        <div>{Object.entries(sessionStats).filter(([,v]) => v > 0).map(([k,v]) => <span key={k} style={{ marginLeft:8 }}>{k[0].toUpperCase()}:{v}</span>)}</div>
      </div>

      {/* Flashcard with swipe */}
      <SwipeCard enabled={flipped || checked} onLeft={() => rate("again")} onRight={() => rate("good")}>
        <div className="flashcard" style={{ marginBottom:18 }} onClick={() => !checked && setFlipped(f => !f)}>
          <div className={`flashcard-inner ${flipped ? "flipped" : ""}`}>
            <div className="flashcard-front">
              <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap", justifyContent:"center" }}>
                {reverseMode && <Badge v="accent">Reverse</Badge>}
                {studyCurrent.type !== "FillBlank" && <Badge v="primary">{studyCurrent.type}</Badge>}
                {studyCurrent.answerTypeLabel && studyCurrent.answerTypeLabel !== "Answer" && <Badge v="accent">{studyCurrent.answerTypeLabel}</Badge>}
                {studyCurrent.difficulty && <Badge v={studyCurrent.difficulty === "easy" ? "green" : studyCurrent.difficulty === "hard" ? "red" : "accent"}>{studyCurrent.difficulty}</Badge>}
                {isMarked && <span style={{ color:"var(--accent)" }}>⚑</span>}
              </div>
              <div style={{ fontFamily:"var(--syne)", fontWeight:700, fontSize:21, lineHeight:1.55, textAlign:"center", flex:1, display:"flex", flexDirection:"column", gap:16, alignItems:"center", justifyContent:"center", padding:"0 12px" }}>
                {!reverseMode && <QuestionMedia question={studyCurrent} maxHeight={220} marginBottom={0} />}
                <div>{reverseMode ? studyCurrent.answer : questionPrompt}</div>
              </div>
              {showHint && !reverseMode && <div style={{ fontSize:13, color:"var(--accent)", fontWeight:700, marginTop:10 }}>💡 {studyCurrent.answer?.[0]?.toUpperCase()}…</div>}
              <div style={{ fontSize:12, color:"var(--muted)", marginTop:12 }}>Tap to flip · Space</div>
            </div>
            <div className="flashcard-back">
              <div style={{ fontSize:11, color:"var(--muted)", fontWeight:700, letterSpacing:1.2, marginBottom:10, textTransform:"uppercase" }}>{reverseMode ? "Question" : "Answer"}</div>
              <div style={{ fontFamily:"var(--syne)", fontWeight:700, fontSize:reverseMode ? 21 : 24, color:reverseMode ? "var(--text)" : "var(--green)", lineHeight:1.5, textAlign:"center", flex:1, display:"flex", flexDirection:"column", gap:16, alignItems:"center", justifyContent:"center" }}>
                {reverseMode && <QuestionMedia question={studyCurrent} maxHeight={220} marginBottom={0} />}
                <div>{reverseMode ? questionPrompt : studyCurrent.answer}</div>
              </div>
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); Speech.speak(reverseMode ? questionPrompt : studyCurrent.answer, settings.ttsLang, settings.ttsRate); }}>🔊</button>
                {settings.repeatAfterMe && <button className="btn btn-ghost btn-sm" style={{ color:"var(--accent)" }} onClick={e => { e.stopPropagation(); setShowRepeat(r => !r); }}>🎙️</button>}
              </div>
              {showRepeat && settings.repeatAfterMe && (
                <div onClick={e => e.stopPropagation()} style={{ width:"100%", marginTop:8 }}>
                  <RepeatAfterMe text={reverseMode ? questionPrompt : studyCurrent.answer} lang={settings.ttsLang} tolerance={settings.accentTolerance} />
                </div>
              )}
            </div>
          </div>
        </div>
      </SwipeCard>

      {/* Answer input / Rating */}
      <div className="card">
        {!flipped && !checked && ["MCQ","TrueFalse","MultiSelect","Match","Order","Cloze","Dictation"].includes(studyCurrent.type) ? (
          <QuestionRenderer question={studyCurrent} userAnswer={userAnswer} onAnswer={a => { setUserAnswer(a); if (["MCQ","TrueFalse"].includes(studyCurrent.type)) setFlipped(true); }}
            checked={false} reverseMode={reverseMode} ttsLang={settings.ttsLang} ttsRate={settings.ttsRate} showHint={showHint} showExplanation={false} />
        ) : !flipped && !checked ? (
          <div>
            <div style={{ display:"flex", gap:8, marginBottom:10 }}>
              <input className="input" placeholder={getAnswerPlaceholder(studyCurrent.type, studyCurrent.answerTypeLabel)} value={userAnswer} onChange={e => setUserAnswer(e.target.value)} onKeyDown={e => {
  if (e.key === "Enter" && userAnswer) {
    const correct =
      userAnswer.trim().toLowerCase() ===
      String(studyCurrent.answer).trim().toLowerCase();
    setIsCorrect(correct);
    setChecked(true);
  }
}} autoFocus />
              <button className="btn btn-ghost" onClick={() => Speech.listen(t => setUserAnswer(t), () => {}, settings.ttsLang)}>🎤</button>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button
  className="btn btn-primary"
  style={{ flex:1 }}
  onClick={() => {
    const correct =
      userAnswer.trim().toLowerCase() ===
      String(studyCurrent.answer).trim().toLowerCase();

    setIsCorrect(correct);
    setChecked(true);
  }}
  disabled={!userAnswer}
>
  Check
</button> 
              <button className="btn btn-ghost" onClick={() => setFlipped(true)}>Reveal</button>
              <button className="btn btn-ghost" onClick={skip}>⏭</button>
            </div>
          </div>
        ) : null}
        {(flipped || checked) && (
          <div>
            {checked && (
  <div style={{
      textAlign: "center",
      fontWeight: 700,
      marginBottom: 10,
      color: isCorrect ? "var(--green)" : "var(--red)"
  }}>
    {isCorrect ? "✓ Correct" : `✗ Correct answer: ${studyCurrent.answer}`}
  </div>
)}
            <div style={{ fontSize:12, color:"var(--muted)", fontWeight:700, textAlign:"center", marginBottom:10 }}>HOW WAS IT? <span style={{ opacity:.5 }}>(swipe · 1–4)</span></div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
              {RATINGS.map(r => (
                <button key={r.key} className="rate-btn" style={{ "--rc": r.color }} onClick={() => rate(r.key)}>
                  <div style={{ fontSize:20 }}>{r.icon}</div>
                  <div style={{ fontWeight:800, fontSize:13 }}>{r.label}</div>
                  <div style={{ fontSize:10, opacity:.6 }}>[{r.k}]</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{ textAlign:"center", fontSize:11, color:"var(--muted)", marginTop:12, opacity:.6 }}>
        Space=flip · 1–4=rate · Swipe after flip · H=hint · R=reverse · S=skip · M=mark
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §16  CSV IMPORT PREVIEW MODAL
// ══════════════════════════════════════════════════════════════
function CSVImportModal({ subjectId, onClose, onImport }) {
  const [step, setStep] = useState("upload");
  const [mode, setMode] = useState("csv");
  const [parsed, setParsed] = useState(null);
  const [filename, setFilename] = useState("");
  const [topicName, setTopic] = useState("");
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const modeMeta = IMPORT_MODE_META[mode];

  function resetFilePicker() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function guessTopicName(fileName, importMode) {
    const pattern = importMode === "zip" ? /\.zip$/i : /\.(csv|txt)$/i;
    return fileName.replace(pattern, "").replace(/[_-]/g, " ").trim();
  }

  function switchMode(nextMode) {
    if (!IMPORT_MODE_META[nextMode] || nextMode === mode) return;
    setMode(nextMode);
    setParsed(null);
    setFilename("");
    setTopic("");
    setError("");
    setDragActive(false);
    setStep("upload");
    resetFilePicker();
  }

  async function handleFile(file) {
    if (!file) return;
    const nextMode = detectImportMode(file);
    if (!nextMode) {
      setDragActive(false);
      setError("Please choose a .csv, .txt, or .zip file.");
      return;
    }

    resetFilePicker();
    if (nextMode !== mode) setMode(nextMode);
    setFilename(file.name);
    setError("");
    setParsed(null);
    setDragActive(false);

    try {
      const result = nextMode === "zip" ? await ImageZip.parse(file) : CSV.parse(await file.text());
      if (result.errors.length) {
        setError(result.errors.join("; "));
        return;
      }
      setParsed(result);
      setTopic(guessTopicName(file.name, nextMode) || "Imported Questions");
      setStep("preview");
    } catch (e) {
      console.error("Question import parse failed:", e);
      setError(e?.message || String(e));
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) handleFile(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer?.files || []);
    const file = dropped.find(item => !!detectImportMode(item));
    if (!file) {
      setDragActive(false);
      setError("Please choose a .csv, .txt, or .zip file.");
      return;
    }
    handleFile(file);
  }

  async function doImport() {
    setStep("importing");
    try {
      await onImport(subjectId, topicName, parsed.rows);
      setStep("done");
    } catch (e) {
      console.error("Question import failed:", e);
      setError(e?.message || String(e));
      setStep("preview");
    }
  }

  return (
    <Modal title="Import CSV or ZIP Images" onClose={onClose} wide>
      {step === "upload" && (
        <div>
          <div className="card" style={{ marginBottom:16, padding:14 }}>
            <div style={{ fontWeight:700, fontSize:13, marginBottom:6 }}>Two import methods are available</div>
            <div style={{ fontSize:12, color:"var(--muted)", lineHeight:1.6 }}>
              Use <strong>CSV + Media URLs</strong> for hosted image or audio links. Use <strong>ZIP Images</strong> when the picture filename should become the answer.
            </div>
          </div>
          <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
            {Object.entries(IMPORT_MODE_META).map(([key, meta]) => (
              <button
                key={key}
                className={`tab-btn ${mode === key ? "active" : ""}`}
                type="button"
                onClick={() => switchMode(key)}
              >
                {meta.label}
              </button>
            ))}
          </div>
          <div
            onDragEnter={e => { e.preventDefault(); setDragActive(true); }}
            onDragOver={e => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
              if (!dragActive) setDragActive(true);
            }}
            onDragLeave={e => {
              e.preventDefault();
              setDragActive(false);
            }}
            onDrop={handleDrop}
            style={{
              border:`2px dashed ${dragActive ? "var(--primary)" : "var(--border)"}`,
              borderRadius:14,
              padding:40,
              textAlign:"center",
              marginBottom:16,
              background:dragActive ? "rgba(99,102,241,.08)" : "transparent",
              transition:"border-color .18s ease, background .18s ease",
            }}
          >
            <div style={{ fontSize:48, marginBottom:12 }}>📥</div>
            <div style={{ fontSize:11, fontWeight:800, letterSpacing:.4, color:"var(--primary)", textTransform:"uppercase", marginBottom:6 }}>
              {mode === "zip" ? "ZIP Image Import" : "CSV Import"}
            </div>
            <div style={{ fontWeight:700, fontSize:15, marginBottom:8 }}>{modeMeta.prompt}</div>
            <div style={{ fontSize:12, color:"var(--muted)", marginBottom:8 }}>{modeMeta.helper}</div>
            {mode === "csv" && <div style={{ fontSize:12, color:"var(--muted)", marginBottom:16 }}>Columns: question_text, difficulty, subtopic, explanation, media, media_url, options, answer-{"{answer-type}"} (optional: type)</div>}
            {mode === "zip" && <div style={{ fontSize:12, color:"var(--muted)", marginBottom:16 }}>Optional folders become subtopics. Example: <code>Fruits/Apple.jpg</code> imports answer <code>Apple</code> under subtopic <code>Fruits</code>.</div>}
            <button className="btn btn-primary btn-lg" type="button" onClick={() => fileInputRef.current?.click()}>
              {mode === "zip" ? "Choose ZIP" : "Choose File"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={modeMeta.accept}
              style={{ display:"none" }}
              onChange={handleFileChange}
            />
            {filename && <div style={{ fontSize:12, color:"var(--muted)", marginTop:12 }}>{filename}</div>}
          </div>
          {error && <div style={{ background:"var(--red)15", border:"1px solid var(--red)40", borderRadius:10, padding:"10px 14px", color:"var(--red)", fontSize:13 }}>❌ {error}</div>}
          <div className="card" style={{ marginTop:16, padding:14, display: mode === "csv" ? "block" : "none" }}>
            <div style={{ fontWeight:700, fontSize:13, marginBottom:8 }}>📋 CSV Format Example</div>
            <pre style={{ fontSize:11, color:"var(--muted)", overflow:"auto", fontFamily:"monospace", lineHeight:1.8 }}>{
`question_text,difficulty,subtopic,explanation,media,options,answer
Capital of France?,medium,Geography,Choose one,,"Paris,London,Berlin,Rome",Paris
The sky is blue.,easy,Science,Answer true or false,,,True
Identify this monument,medium,Landmarks,Uses the supplied image,https://example.com/taj-mahal.jpg,,Taj Mahal`
            }</pre>
          </div>
          {mode === "zip" && (
            <div className="card" style={{ marginTop:16, padding:14 }}>
              <div style={{ fontWeight:700, fontSize:13, marginBottom:8 }}>ZIP Import Example</div>
              <pre style={{ fontSize:11, color:"var(--muted)", overflow:"auto", fontFamily:"monospace", lineHeight:1.8 }}>{
`animals/
  tiger.jpg
  polar-bear.png
flags/
  india.png

Results:
- tiger.jpg -> answer "tiger"
- polar-bear.png -> answer "polar bear"
- india.png -> answer "india"
- animals / flags become subtopics`
              }</pre>
            </div>
          )}
        </div>
      )}

      {step === "preview" && parsed && (
        <div>
          <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap" }}>
            <div className="card" style={{ flex:1, padding:"10px 14px", textAlign:"center" }}><div style={{ fontFamily:"var(--syne)", fontWeight:800, fontSize:22, color:"var(--green)" }}>{parsed.rows.length}</div><div style={{ fontSize:11, color:"var(--muted)" }}>Questions</div></div>
            <div className="card" style={{ flex:1, padding:"10px 14px", textAlign:"center" }}><div style={{ fontFamily:"var(--syne)", fontWeight:800, fontSize:22, color:"var(--accent)" }}>{parsed.warnings.length}</div><div style={{ fontSize:11, color:"var(--muted)" }}>Warnings</div></div>
            <div className="card" style={{ flex:1, padding:"10px 14px", textAlign:"center" }}><div style={{ fontFamily:"var(--syne)", fontWeight:800, fontSize:22, color:"var(--primary)" }}>{Object.keys(CSV.groupBySubtopic(parsed.rows, topicName)).length}</div><div style={{ fontSize:11, color:"var(--muted)" }}>Subtopics</div></div>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ fontSize:13, fontWeight:700, display:"block", marginBottom:6 }}>Topic Name</label>
            <input className="input" value={topicName} onChange={e => setTopic(e.target.value)} />
          </div>
          {parsed.warnings.length > 0 && (
            <div style={{ background:"var(--accent)10", border:"1px solid var(--accent)30", borderRadius:10, padding:"10px 14px", marginBottom:12, fontSize:12, color:"var(--accent)" }}>
              ⚠️ {parsed.warnings.slice(0,3).join(" · ")}{parsed.warnings.length > 3 ? ` (+${parsed.warnings.length-3} more)` : ""}
            </div>
          )}
          <div className="card" style={{ marginBottom:14, padding:14 }}>
            <div style={{ fontWeight:700, fontSize:13, marginBottom:10 }}>Preview (first 5 questions)</div>
            {parsed.preview.map((r, i) => (
              <div key={i} style={{ padding:"8px 0", borderBottom:"1px solid var(--border)", fontSize:13 }}>
                <div style={{ display:"flex", gap:6, marginBottom:4 }}>
                  <Badge v={r.difficulty === "easy" ? "green" : r.difficulty === "hard" ? "red" : "accent"}>{r.difficulty}</Badge>
                  <Badge v="primary">{r.type}</Badge>
                  {r.subtopic_hint && <Badge v="muted">{r.subtopic_hint}</Badge>}
                </div>
                <div style={{ fontWeight:700 }}>{getQuestionLabel(r)}</div>
                <div style={{ color:"var(--green)", fontSize:12 }}>→ {getQuestionAnswerPreview(r)}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setParsed(null); setStep("upload"); setError(""); }}>← Back</button>
            <button className="btn btn-primary btn-lg" style={{ flex:2 }} onClick={doImport} disabled={!topicName.trim()}>✅ Import {parsed.rows.length} Questions</button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <div style={{ textAlign:"center", padding:40 }}>
          <div style={{ fontSize:48, marginBottom:14 }} className="pulsing">⏳</div>
          <div style={{ fontWeight:700 }}>Importing to Dexie database…</div>
        </div>
      )}

      {step === "done" && (
        <div style={{ textAlign:"center", padding:40 }}>
          <div style={{ fontSize:64 }}>✅</div>
          <div className="h2" style={{ marginTop:14, color:"var(--green)" }}>Import Complete!</div>
          <div style={{ color:"var(--muted)", marginTop:8, marginBottom:22 }}>{parsed?.rows.length} questions added to "{topicName}"</div>
          <button className="btn btn-primary btn-lg" onClick={onClose}>Done</button>
        </div>
      )}
    </Modal>
  );
}

// ══════════════════════════════════════════════════════════════
// §17  QUIZ SCREEN — Adaptive, Timer, Explanations, Wrong-review
// ══════════════════════════════════════════════════════════════
function QuizScreen() {
  const { questions, subtopics, settings, nav, navigate, saveQuizAttempt, currentProfile, selectAdaptive, applyRating } = useApp();
  const questionMode = nav.questionMode || "mixed";

  const pool = useMemo(() => {
    if (nav.wrongOnly) return nav.wrongQs || [];
    const st = nav.subtopicId;
    const tid = nav.topicId;
    const basePool = st ? questions.filter(q => q.stid === st)
                        : tid ? questions.filter(q => subtopics.find(s => s.id === q.stid)?.tid === tid) : [];
    return basePool.filter(q => questionMode === "mixed" ? true : questionMode === "image" ? isImageQuestion(q) : !isImageQuestion(q));
  }, [nav, questions, subtopics, questionMode]);

  const quizLen  = Math.min(pool.length, settings.quizLen || 10);
  const qList    = useMemo(
    () => selectAdaptive(pool, quizLen).map((q, index) => prepareQuestionForStudy(q, "", `${questionMode}-${index}`)),
    [pool, quizLen, questionMode]
  );
  const [qi,  setQi]      = useState(0);
  const [ua,  setUa]      = useState("");
  const [results, setR]   = useState({});
  const [checked, setChk] = useState(false);
  const [done,    setDone]= useState(false);
  const [tLeft,   setTL]  = useState(settings.timerSec || 30);
  const startMs = useRef(Date.now());

  const current = qList[qi];

  useEffect(() => { setUa(""); setChk(false); setTL(settings.timerSec || 30); }, [qi]);
  useEffect(() => { if (!settings.autoTTS || !current || checked || done) return; Speech.speak(getQuestionLabel(current), settings.ttsLang, settings.ttsRate); }, [qi, settings.autoTTS]);

  useEffect(() => {
    if (!settings.timerSec || checked || done || !current) return;
    if (tLeft <= 0) { check(); return; }
    const t = setInterval(() => setTL(l => l - 1), 1000);
    return () => clearInterval(t);
  }, [tLeft, checked, done]);

  function check() {
    setChk(true); Speech.cancel();
    const q = current;
    let correct = false;
    const ans = ua;
    const ca = q.answer.trim().toLowerCase().replace(/[.,!?]/g,"");
    switch (q.type) {
      case "MCQ": case "TrueFalse": correct = ans.trim().toLowerCase() === q.answer.trim().toLowerCase(); break;
      case "MultiSelect": {
        const sa=new Set(ans.split(",").map(s=>s.trim().toLowerCase()));
        const ga=new Set(q.answer.split(",").map(s=>s.trim().toLowerCase()));
        correct=[...sa].every(x=>ga.has(x))&&[...ga].every(x=>sa.has(x)); break;
      }
      case "Match": {
        const sp=ans.split(",").map(p=>{const[l,r]=p.split(":").map(s=>s.trim());return{l,r};});
        const cp=(q.options||"").split(",").map(p=>{const[l,r]=p.split(":").map(s=>s.trim());return{l,r};});
        correct=cp.every(c=>sp.find(s=>s.l===c.l&&s.r===c.r)); break;
      }
      case "Order": {
        const sa=ans.split(",").map(s=>s.trim());const ca2=q.answer.split(",").map(s=>s.trim());
        correct=sa.join("|")===ca2.join("|"); break;
      }
      case "Cloze": {
        const sa=ans.split(",").map(s=>s.trim().toLowerCase());const ca2=q.answer.split(",").map(s=>s.trim().toLowerCase());
        correct=sa.join("|")===ca2.join("|"); break;
      }
      default: correct=ans.trim().toLowerCase().replace(/[.,!?]/g,"")===ca;
    }
    const r = { question:q, answer:ans, correct, responseMs:Date.now()-startMs.current };
    const newR = { ...results, [qi]: r };
    setR(newR);
    applyRating(q.id, correct ? "good" : "again", r.responseMs);
    if (settings.hapticFeedback) haptic(correct ? "success" : "error");
    if (qi < qList.length - 1) setTimeout(() => { setQi(i => i+1); startMs.current = Date.now(); }, 1500);
    else setTimeout(() => finish(newR), 1500);
  }

  async function finish(allR) {
    const allResults = Object.values(allR);
    const correct = allResults.filter(r => r.correct).length;
    await saveQuizAttempt(nav.subtopicId, nav.topicId, correct, qList.length, allResults);
    setDone(true);
  }

  if (!qList.length) {
    const emptyTitle = questionMode === "image" ? "No image questions" : questionMode === "text" ? "No text questions" : "Not enough questions";
    const fallbackTopicId = nav.topicId || subtopics.find(s => s.id === nav.subtopicId)?.tid;
    const backScreen = nav.topicId ? "topics" : "subtopics";
    const backCtx = nav.topicId ? { subjectId: nav.subjectId } : { topicId: fallbackTopicId, subjectId: nav.subjectId };
    return <Empty icon="❓" title={emptyTitle} sub="Import more questions first" action={<button className="btn btn-primary btn-lg" onClick={() => navigate(backScreen, backCtx)}>Back</button>} />;
  }

  if (done) {
    const allResults = Object.values(results);
    const correct = allResults.filter(r => r.correct).length;
    const pct = Math.round(correct / qList.length * 100);
    const pass = pct >= (settings.passThreshold || 70);
    const wrongQs = allResults.filter(r => !r.correct).map(r => r.question);
    return (
      <div style={{ maxWidth:560, margin:"0 auto", textAlign:"center", padding:"32px 0" }}>
        <div style={{ fontSize:80 }}>{pct>=90?"🏆":pct>=70?"🎉":pct>=50?"💪":"📚"}</div>
        <div className="h1" style={{ color:pass?"var(--green)":"var(--accent)", marginTop:12 }}>{pct}%</div>
        <div style={{ fontSize:16, color:"var(--muted)", marginTop:6 }}>{correct}/{qList.length} correct · {pass?"PASS ✓":"NEEDS WORK"}</div>
        <div className="card" style={{ margin:"22px auto", padding:22, maxWidth:420, textAlign:"left" }}>
          {allResults.map((r,i) => (
            <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:12, paddingBottom:12, borderBottom:i<allResults.length-1?"1px solid var(--border)":"none" }}>
              <span style={{ fontSize:18, flexShrink:0 }}>{r.correct?"✅":"❌"}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:600, fontSize:13, marginBottom:3, lineHeight:1.4 }}>{getQuestionLabel(r.question).slice(0,80)}{getQuestionLabel(r.question).length>80?"…":""}</div>
                {!r.correct && <><div style={{ fontSize:12, color:"var(--red)" }}>You: {r.answer||"(none)"}</div><div style={{ fontSize:12, color:"var(--green)" }}>✓ {r.question.answerTypeLabel && r.question.answerTypeLabel !== "Answer" ? `${r.question.answerTypeLabel}: ` : ""}{r.question.answer}</div></>}
                {settings.showExplanations && r.question.explanation && <div style={{ fontSize:11, color:"var(--primary)", marginTop:4, fontStyle:"italic" }}>💡 {r.question.explanation}</div>}
              </div>
              <div style={{ fontSize:11, color:"var(--muted)", flexShrink:0 }}>{Math.round(r.responseMs/1000)}s</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
          {wrongQs.length > 0 && <button className="btn btn-accent btn-lg" onClick={() => navigate("quiz",{...nav, wrongOnly:true, wrongQs})}>📋 Review Wrong ({wrongQs.length})</button>}
          <button className="btn btn-ghost btn-lg" onClick={() => navigate("quiz", nav)}>🔄 Retry</button>
          <button className="btn btn-primary btn-lg" onClick={() => navigate("subtopics")}>✓ Done</button>
        </div>
      </div>
    );
  }

  if (!current) return null;
  const curR = results[qi];
  const timerPct = settings.timerSec > 0 ? tLeft / settings.timerSec * 100 : 100;

  return (
    <div style={{ maxWidth:620, margin:"0 auto" }}>
      {settings.timerSec > 0 && !checked && (
        <div style={{ marginBottom:14 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"var(--muted)", marginBottom:4 }}>
            <span>Q{qi+1}/{qList.length}{settings.adaptiveQuiz && <span style={{ color:"var(--primary)", marginLeft:8 }}>★ Adaptive</span>}</span>
            <span style={{ fontWeight:800, color:tLeft<=5?"var(--red)":tLeft<=10?"var(--accent)":"var(--muted)" }}>⏱ {tLeft}s</span>
          </div>
          <div className="pbar"><div className="pbar-fill" style={{ width:`${timerPct}%`, background:tLeft<=5?"var(--red)":tLeft<=10?"var(--accent)":"var(--primary)", transition:"width 1s linear" }} /></div>
        </div>
      )}
      {!settings.timerSec && <div style={{ fontSize:12, color:"var(--muted)", marginBottom:10 }}>Q{qi+1}/{qList.length}</div>}

      <div className="card" style={{ marginBottom:16, padding:24 }}>
        <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
          <Badge v="primary">{current.type}</Badge>
          {current.answerTypeLabel && current.answerTypeLabel !== "Answer" && <Badge v="accent">{current.answerTypeLabel}</Badge>}
          {current.difficulty && <Badge v={current.difficulty==="easy"?"green":current.difficulty==="hard"?"red":"accent"}>{current.difficulty}</Badge>}
          {nav.reverseMode && <Badge v="accent">Reverse</Badge>}
        </div>
        <div style={{ fontFamily:"var(--syne)", fontWeight:700, fontSize:20, lineHeight:1.6, color:"var(--text)", marginBottom:18 }}>
          {nav.reverseMode ? `Answer: "${current.answer}"` : getQuestionLabel(current)}
        </div>
        <QuestionRenderer question={current} userAnswer={ua} onAnswer={setUa} checked={checked}
          reverseMode={nav.reverseMode} ttsLang={settings.ttsLang} ttsRate={settings.ttsRate}
          showExplanation={settings.showExplanations} showHint={false} />
        {checked && (
          <div style={{ marginTop:14, padding:"12px 16px", borderRadius:10, background:curR?.correct?"#10B98115":"#EF444415", border:`1px solid ${curR?.correct?"var(--green)":"var(--red)"}40` }}>
            <div style={{ fontWeight:800, fontSize:16, color:curR?.correct?"var(--green)":"var(--red)" }}>{curR?.correct?"✅ Correct!":"❌ Incorrect"}</div>
            {!curR?.correct && <div style={{ fontSize:13, marginTop:4 }}>{current.answerTypeLabel && current.answerTypeLabel !== "Answer" ? `${current.answerTypeLabel}: ` : "Answer: "}<strong>{current.answer}</strong></div>}
          </div>
        )}
      </div>
      {!checked && <button className="btn btn-primary btn-lg" style={{ width:"100%" }} onClick={check} disabled={!ua && !["Match","Order"].includes(current.type)}>Submit Answer</button>}
      {checked && qi < qList.length-1 && <div style={{ textAlign:"center", color:"var(--muted)", fontSize:13 }}>Next…</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §18  ANALYTICS — reviewHistory-backed, 5 tabs
// ══════════════════════════════════════════════════════════════
function AnalyticsScreen() {
  const { flashProg, quizAttempts, questions, subtopics, topics, reviewHistory, progMap, navigate } = useApp();
  const [tab, setTab] = useState("overview");

  // ── Overview metrics ────────────────────────────────────────
  const stats = useMemo(() => {
    const total     = questions.length;
    const mastered  = flashProg.filter(f=>f.status==="mastered").length;
    const learning  = flashProg.filter(f=>["learning","review"].includes(f.status)).length;
    const due       = flashProg.filter(f=>SRS.isDue(f)&&f.status!=="mastered").length;
    const totalShown  = flashProg.reduce((a,f)=>a+(f.totalShown||0),0);
    const totalCorrect= flashProg.reduce((a,f)=>a+(f.correctCount||0),0);
    const overallAcc  = totalShown>0?Math.round(totalCorrect/totalShown*100):0;
    const retentions  = flashProg.filter(f=>f.lastReview).map(f=>SRS.retention(f));
    const avgRet      = retentions.length?Math.round(retentions.reduce((a,b)=>a+b,0)/retentions.length):0;
    const avgScore    = quizAttempts.length?Math.round(quizAttempts.reduce((a,q)=>a+(q.pct||0),0)/quizAttempts.length):0;
    const masteredPct = total>0?Math.round(mastered/total*100):0;
    return { total, mastered, learning, due, overallAcc, avgRet, forgettingRate:100-avgRet, avgScore, totalShown, masteredPct };
  }, [flashProg, quizAttempts, questions]);

  // ── Accuracy trend (reviewHistory-backed) ──────────────────
  const accTrend = useMemo(() => {
    // Group reviewHistory by day, compute daily accuracy
    const byDay = {};
    for (const r of reviewHistory) {
      const d = new Date(r.timestamp).toLocaleDateString("en",{month:"short",day:"numeric"});
      byDay[d] = byDay[d] || { correct:0, total:0 };
      byDay[d].total++;
      if (r.correct) byDay[d].correct++;
    }
    return Object.entries(byDay).slice(-14).map(([date,{correct,total}])=>({ date, acc:Math.round(correct/total*100) }));
  }, [reviewHistory]);

  // ── Forgetting curve distribution ──────────────────────────
  const forgDist = useMemo(() => {
    const buckets = {"0–20":0,"21–40":0,"41–60":0,"61–80":0,"81–100":0};
    flashProg.filter(f=>f.lastReview).forEach(f=>{
      const r=SRS.retention(f);
      if(r<=20)buckets["0–20"]++;else if(r<=40)buckets["21–40"]++;else if(r<=60)buckets["41–60"]++;else if(r<=80)buckets["61–80"]++;else buckets["81–100"]++;
    });
    return Object.entries(buckets).map(([range,count])=>({range,count}));
  }, [flashProg]);

  // ── Heatmap (reviewHistory-backed) ─────────────────────────
  const heatmap = useMemo(() => {
    const dayMap = {};
    for (const r of reviewHistory) {
      const d = new Date(r.timestamp).toDateString();
      dayMap[d] = (dayMap[d]||0)+1;
    }
    const weeks = [];
    const d = new Date(); d.setDate(d.getDate()-d.getDay()-7*12);
    for (let w=0;w<13;w++){
      const week=[];
      for(let i=0;i<7;i++){ week.push({date:d.toDateString(),count:dayMap[d.toDateString()]||0}); d.setDate(d.getDate()+1); }
      weeks.push(week);
    }
    return weeks;
  }, [reviewHistory]);

  // ── Lesson accuracy ─────────────────────────────────────────
  const lessonAcc = useMemo(() => subtopics.map(st=>{
    const qs=questions.filter(q=>q.stid===st.id);
    if(!qs.length)return null;
    const progs=qs.map(q=>progMap.get(q.id)).filter(p=>p&&p.totalShown>0);
    if(!progs.length)return null;
    const acc=Math.round(progs.reduce((a,p)=>a+(p.correctCount/p.totalShown),0)/progs.length*100);
    const ret=Math.round(progs.map(p=>SRS.retention(p)).reduce((a,b)=>a+b,0)/progs.length);
    return {name:st.name.slice(0,20),acc,ret,total:qs.length,mastered:progs.filter(p=>p.status==="mastered").length};
  }).filter(Boolean).sort((a,b)=>a.acc-b.acc), [subtopics, questions, progMap]);

  const HC = ["var(--surface)","#6366F118","#6366F144","#6366F177","#6366F1AA","#6366F1"];
  const TABS = ["overview","trend","lessons","heatmap","forgetting"];

  return (
    <div>
      <div className="h1" style={{marginBottom:6}}>📊 Analytics</div>
      <div style={{color:"var(--muted)",fontSize:14,marginBottom:18}}>All metrics backed by reviewHistory table</div>
      <div className="tab-bar" style={{marginBottom:20}}>
        {TABS.map(t=><button key={t} className={`tab-btn ${tab===t?"active":""}`} onClick={()=>setTab(t)} style={{textTransform:"capitalize"}}>{t}</button>)}
      </div>

      {tab==="overview"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {icon:"🃏",val:stats.total,label:"Total Cards"},
              {icon:"⭐",val:stats.mastered,label:"Mastered",col:"var(--green)"},
              {icon:"📖",val:stats.learning,label:"Learning",col:"var(--primary)"},
              {icon:"⏰",val:stats.due,label:"Due Now",col:stats.due>0?"var(--accent)":"var(--green)"},
              {icon:"🎯",val:`${stats.overallAcc}%`,label:"Overall Accuracy",col:stats.overallAcc>=70?"var(--green)":"var(--red)"},
              {icon:"🧠",val:`${stats.avgRet}%`,label:"Avg Retention",col:stats.avgRet>=60?"var(--green)":"var(--accent)"},
              {icon:"📉",val:`${stats.forgettingRate}%`,label:"Forgetting Rate",col:stats.forgettingRate<30?"var(--green)":"var(--red)"},
              {icon:"📝",val:`${stats.avgScore}%`,label:"Quiz Average",col:stats.avgScore>=70?"var(--green)":"var(--accent)"},
              {icon:"🔢",val:reviewHistory.length,label:"Total Reviews"},
              {icon:"📈",val:`${stats.masteredPct}%`,label:"Mastery %",col:"var(--green)"},
            ].map(s=>(
              <div key={s.label} className="card" style={{padding:"14px 12px",textAlign:"center"}}>
                <div style={{fontSize:26,marginBottom:6}}>{s.icon}</div>
                <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:22,color:s.col||"var(--text)"}}>{s.val}</div>
                <div style={{fontSize:11,color:"var(--muted)",fontWeight:600,marginTop:2}}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab==="trend"&&(
        <div className="card" style={{padding:20}}>
          <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Daily Accuracy (reviewHistory-backed)</div>
          <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>Each data point = reviews done that day</div>
          {accTrend.length<2?<Empty icon="📈" title="Study more to see trends" sub="Need at least 2 days of data" />:(
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={accTrend}>
                <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3}/><stop offset="95%" stopColor="var(--primary)" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{fill:"var(--muted)",fontSize:10}} />
                <YAxis domain={[0,100]} tick={{fill:"var(--muted)",fontSize:11}} tickFormatter={v=>`${v}%`} />
                <Tooltip formatter={v=>`${v}%`} contentStyle={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:8,fontSize:12}} />
                <Area type="monotone" dataKey="acc" stroke="var(--primary)" fill="url(#ag)" strokeWidth={2.5} dot={{fill:"var(--primary)",r:4}} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {tab==="lessons"&&(
        <div className="card" style={{padding:20}}>
          <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>Lesson Accuracy & Retention</div>
          {!lessonAcc.length?<Empty icon="📚" title="No data" sub="Study some cards first" />:lessonAcc.map((l,i)=>(
            <div key={i} style={{marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <span style={{fontWeight:700,fontSize:13}}>{l.name}</span>
                <div style={{display:"flex",gap:10}}>
                  <span style={{fontSize:11,color:"var(--primary)"}}>⏳ {l.ret}%</span>
                  <span style={{fontWeight:800,color:l.acc>=70?"var(--green)":l.acc>=50?"var(--accent)":"var(--red)"}}>{l.acc}%</span>
                </div>
              </div>
              <div style={{height:8,background:"var(--border)",borderRadius:6,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${l.acc}%`,background:l.acc>=70?"var(--green)":l.acc>=50?"var(--accent)":"var(--red)",borderRadius:6,transition:"width .5s"}} />
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==="heatmap"&&(
        <div className="card" style={{padding:20}}>
          <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>Study Heatmap (13 weeks · reviewHistory)</div>
          <div style={{overflowX:"auto"}}>
            <div style={{display:"flex",gap:3}}>
              {heatmap.map((week,wi)=>(
                <div key={wi} style={{display:"flex",flexDirection:"column",gap:3}}>
                  {week.map((day,di)=>{
                    const lvl=day.count===0?0:day.count<3?1:day.count<6?2:day.count<10?3:day.count<15?4:5;
                    return <div key={di} title={`${day.date}: ${day.count}`} style={{width:13,height:13,borderRadius:2,background:HC[lvl],border:"1px solid var(--border)"}} />;
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab==="forgetting"&&(
        <div>
          <div className="card" style={{padding:20,marginBottom:14}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Forgetting Curve — Ebbinghaus R=e^(-t/S)</div>
            <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:14}}>
              <div className="card" style={{padding:"10px 14px",flex:1,textAlign:"center"}}><div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:24,color:"var(--green)"}}>{stats.avgRet}%</div><div style={{fontSize:11,color:"var(--muted)"}}>Avg Retention</div></div>
              <div className="card" style={{padding:"10px 14px",flex:1,textAlign:"center"}}><div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:24,color:"var(--red)"}}>{stats.forgettingRate}%</div><div style={{fontSize:11,color:"var(--muted)"}}>Forgetting Rate</div></div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={forgDist}>
                <XAxis dataKey="range" tick={{fill:"var(--muted)",fontSize:11}} />
                <YAxis tick={{fill:"var(--muted)",fontSize:11}} />
                <Tooltip contentStyle={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:8,fontSize:12}} />
                <Bar dataKey="count" name="Cards" radius={[6,6,0,0]}>
                  {forgDist.map((_,i)=><Cell key={i} fill={i<2?"var(--red)":i<3?"var(--accent)":"var(--green)"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card" style={{padding:20}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Overdue Cards</div>
            {flashProg.filter(f=>SRS.isDue(f)&&f.status!=="mastered").slice(0,6).map((f,i)=>{
              const q=questions.find(q=>q.id===f.qid);
              if(!q)return null;
              return (
                <div key={i} style={{display:"flex",gap:10,marginBottom:8,padding:"8px 12px",background:"var(--surface)",borderRadius:8}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:SRS.retention(f)<30?"var(--red)":"var(--accent)",marginTop:5,flexShrink:0}} />
                  <div style={{flex:1,fontSize:13}}>{getQuestionLabel(q).slice(0,60)}…</div>
                  <span style={{fontSize:11,color:"var(--muted)"}}>Box {f.box}</span>
                  <span style={{fontSize:11,color:"var(--accent)"}}>⏳ {SRS.retention(f)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §19  SETTINGS — All settings, encryption, migration info
// ══════════════════════════════════════════════════════════════
function SettingsScreen() {
  const { settings, saveSettings, exportBackup, importBackup, resetAllStats, navigate, pwaPrompt, currentProfile,
          googleUser, googleClientId, gdriveSyncing, gdriveStatus,
          googleSignIn, googleSignOut,
          syncProfileToDrive, restoreFromDrive } = useApp();
  const [s, setS]       = useState(settings);
  const [sec, setSec]   = useState("general");
  const toggle = k       => setS(p => ({ ...p, [k]: !p[k] }));
  const set_   = (k, v)  => setS(p => ({ ...p, [k]: v }));

  const Row = ({ label, sub, children }) => (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 0", borderBottom:"1px solid var(--border)", gap:16 }}>
      <div><div style={{ fontWeight:700, fontSize:14 }}>{label}</div>{sub && <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>{sub}</div>}</div>
      {children}
    </div>
  );
  const Tog = ({ k }) => (
    <div onClick={() => toggle(k)} style={{ width:44, height:24, borderRadius:12, background:s[k]?"var(--primary)":"var(--border)", cursor:"pointer", display:"flex", alignItems:"center", padding:2, transition:"background .2s", flexShrink:0 }}>
      <div style={{ width:20, height:20, borderRadius:"50%", background:"white", transform:s[k]?"translateX(20px)":"none", transition:"transform .2s", boxShadow:"0 1px 4px rgba(0,0,0,.3)" }} />
    </div>
  );
  const Sel = ({ k, opts }) => (
    <select className="input" style={{ padding:"5px 10px", height:34, width:"auto" }} value={s[k]} onChange={e => set_(k, e.target.value)}>
      {opts.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const Slide = ({ k, min, max, step=1, fmt=v=>v }) => (
    <div style={{ display:"flex", gap:10, alignItems:"center" }}>
      <input type="range" min={min} max={max} step={step} value={s[k]} onChange={e => set_(k,+e.target.value)} style={{ width:90 }} />
      <span style={{ fontSize:13, fontWeight:700, color:"var(--primary)", width:48, textAlign:"right" }}>{fmt(s[k])}</span>
    </div>
  );

  const SECS = ["general","learning","voice","quiz","flash","storage","cloud"];
  return (
    <div style={{ maxWidth:640, margin:"0 auto" }}>
      <div className="h1" style={{ marginBottom:20 }}>⚙️ Settings</div>
      <div className="tab-bar" style={{ marginBottom:20, flexWrap:"wrap" }}>
        {SECS.map(s_ => <button key={s_} className={`tab-btn ${sec===s_?"active":""}`} onClick={() => setSec(s_)} style={{ textTransform:"capitalize" }}>{s_==="cloud"?"☁️ Cloud":s_}</button>)}
      </div>
      <div className="card" style={{ padding:"4px 20px 16px" }}>
        {sec==="general" && (<>
          <Row label="Theme"><Sel k="theme" opts={[["dark","🌙 Dark"],["light","☀️ Light"]]} /></Row>
          <Row label="Font Size"><Sel k="fontSize" opts={[["small","Small"],["medium","Medium"],["large","Large"]]} /></Row>
          <Row label="UI Language"><Sel k="uiLang" opts={[["en","English"],["hi","Hindi"],["ta","Tamil"],["te","Telugu"],["fr","French"],["de","German"],["es","Spanish"],["zh","中文"],["ar","العربية"],["ja","日本語"]]} /></Row>
          <Row label="Haptic Feedback" sub="Vibrate on correct/wrong"><Tog k="hapticFeedback" /></Row>
          <Row label="Focus Mode" sub="Hides nav during study"><Tog k="focusMode" /></Row>
          <Row label="Documentation" sub="Open the full project documentation in a new tab">
            <a className="btn btn-ghost btn-sm" href={DOCUMENTATION_URL} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}>Docs</a>
          </Row>
          {pwaPrompt && <Row label="Install App" sub="Add to home screen"><button className="btn btn-primary btn-sm" onClick={async()=>{pwaPrompt.prompt();await pwaPrompt.userChoice;}}>📲 Install</button></Row>}
        </>)}
        {sec==="learning" && (<>
          <Row label="Spaced Repetition (SM-2)" sub="Ebbinghaus forgetting curve scheduling"><Tog k="spacedRepetition" /></Row>
          <Row label="Daily Flash Goal"><Slide k="dailyFlashGoal" min={5} max={100} step={5} /></Row>
          <Row label="Daily Quiz Goal"><Slide k="dailyQuizGoal" min={1} max={10} /></Row>
          <Row label="Daily Study Goal (min)"><Slide k="dailyStudyGoal" min={5} max={120} step={5} fmt={v=>`${v}m`} /></Row>
          <Row label="Deck Limit" sub="Max cards per session"><Slide k="deckLimit" min={10} max={200} step={10} /></Row>
          <Row label="Smart Shuffle" sub="Prioritize due → weak → new"><Tog k="smartShuffle" /></Row>
          <Row label="Show Forgetting Curve" sub="Retention % on flashcards"><Tog k="showForgettingCurve" /></Row>
          <Row label="Repetition Rounds"><Slide k="repetitionCount" min={1} max={6} /></Row>
        </>)}
        {sec==="voice" && (<>
          <Row label="Auto TTS" sub="Read questions aloud"><Tog k="autoTTS" /></Row>
          <Row label="Repeat After Me" sub="Voice training on card back"><Tog k="repeatAfterMe" /></Row>
          <Row label="Pronunciation Scoring"><Tog k="voiceScoring" /></Row>
          <Row label="Accent Tolerance" sub={`${Math.round(s.accentTolerance*100)}% similarity required`}><Slide k="accentTolerance" min={0.5} max={1} step={0.05} fmt={v=>`${Math.round(v*100)}%`} /></Row>
          <Row label="TTS Language"><Sel k="ttsLang" opts={[["en-US","🇺🇸 English"],["hi-IN","🇮🇳 Hindi"],["ta-IN","🇮🇳 Tamil"],["te-IN","🇮🇳 Telugu"],["fr-FR","🇫🇷 French"],["de-DE","🇩🇪 German"],["es-ES","🇪🇸 Spanish"],["zh-CN","🇨🇳 Chinese"],["ja-JP","🇯🇵 Japanese"]]} /></Row>
          <Row label="Speech Rate"><Slide k="ttsRate" min={0.5} max={2} step={0.1} fmt={v=>`${v}x`} /></Row>
        </>)}
        {sec==="quiz" && (<>
          <Row label="Adaptive Difficulty" sub="Weight questions by weakness"><Tog k="adaptiveQuiz" /></Row>
          <Row label="Show Explanations"><Tog k="showExplanations" /></Row>
          <Row label="Pass Threshold"><Slide k="passThreshold" min={40} max={100} step={5} fmt={v=>`${v}%`} /></Row>
          <Row label="Timer (0=off)"><Slide k="timerSec" min={0} max={120} step={5} fmt={v=>v===0?"Off":`${v}s`} /></Row>
          <Row label="Questions per Quiz"><Slide k="quizLen" min={3} max={30} /></Row>
        </>)}
        {sec==="flash" && (<>
          <Row label="Auto-Reveal Time"><Slide k="autoRevealTime" min={0} max={30} fmt={v=>v===0?"Off":`${v}s`} /></Row>
          <Row label="Hint Mode" sub="Show first letter"><Tog k="hintMode" /></Row>
        </>)}
        {sec==="storage" && (<>
          <Row label="Database Engine"><span style={{ fontSize:12, fontWeight:800, color:"var(--green)" }}>✅ Dexie.js v3.2 · IndexedDB</span></Row>
          <Row label="DB Version"><span style={{ fontSize:12, color:"var(--muted)" }}>v3 (with migrations v1→v2→v3)</span></Row>
          <Row label="Indexes"><span style={{ fontSize:11, color:"var(--muted)", maxWidth:200 }}>[uid+qid], uid, qid, nextReview, stid, tid, sid</span></Row>
          <Row label="Export Backup" sub="JSON (optionally AES-256 encrypted)"><button className="btn btn-ghost btn-sm" onClick={exportBackup}>📤 Export</button></Row>
          <Row label="Import Backup"><label className="btn btn-ghost btn-sm" style={{cursor:"pointer"}}>📥 Import<input type="file" accept=".json" style={{display:"none"}} onChange={async e=>{const f=e.target.files[0];if(f)importBackup(await f.text());}}/></label></Row>
          <Row label="Encrypt Backup" sub="AES-GCM-256 optional encryption"><Tog k="encryptBackup" /></Row>
          {s.encryptBackup && <Row label="Backup Password"><input className="input" type="password" placeholder="Password…" value={s.encryptPassword||""} onChange={e=>set_("encryptPassword",e.target.value)} style={{maxWidth:200}} /></Row>}
          <Row label="Reset Stats" sub="Clear all progress for this profile"><button className="btn btn-sm" style={{background:"var(--red)15",color:"var(--red)",border:"1px solid var(--red)40"}} onClick={()=>{if(window.confirm("Reset all stats?"))resetAllStats();}}>Reset</button></Row>
        </>)}

        {/* ── Cloud / Google Drive Tab ─────────────────────── */}
        {sec==="cloud" && (<>
          {/* Step 1: OAuth config */}
          <div style={{padding:"14px 0",borderBottom:"1px solid var(--border)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>Google Sign-In Configuration</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:10}}>
              Only <code style={{background:"var(--surface)",padding:"1px 5px",borderRadius:4}}>VITE_GOOGLE_CLIENT_ID</code> is required here. Image import no longer uses search API environment variables.
            </div>
            {googleClientId
              ? <div style={{fontSize:11,color:"var(--green)",marginTop:6}}>✅ Client ID configured</div>
              : <div style={{fontSize:11,color:"var(--red)",marginTop:6}}>❌ Missing VITE_GOOGLE_CLIENT_ID</div>
            }
          </div>

          <div style={{padding:"14px 0",borderBottom:"1px solid var(--border)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>Image Import</div>
            <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
              Image questions now come from explicit media only: either a <code style={{background:"var(--surface)",padding:"1px 5px",borderRadius:4}}>media</code> or <code style={{background:"var(--surface)",padding:"1px 5px",borderRadius:4}}>media_url</code> value in CSV, or a ZIP image upload where the filename becomes the answer.
            </div>
            <div style={{fontSize:11,color:"var(--green)",marginTop:8}}>No separate image API keys are required.</div>
          </div>

          {/* Step 2: Sign In */}
          <div style={{padding:"14px 0",borderBottom:"1px solid var(--border)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>Google Account</div>
            {googleUser ? (
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"var(--surface)",borderRadius:12}}>
                {googleUser.picture
                  ? <img src={googleUser.picture} alt="" style={{width:36,height:36,borderRadius:"50%"}} />
                  : <div style={{width:36,height:36,borderRadius:"50%",background:"var(--primary)",display:"flex",alignItems:"center",justifyContent:"center"}}>G</div>
                }
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14}}>{googleUser.name}</div>
                  <div style={{fontSize:12,color:"var(--green)"}}>✅ {googleUser.email}</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={googleSignOut}>Sign Out</button>
              </div>
            ) : (
              <button
                className="btn btn-ghost"
                style={{gap:10,padding:"10px 16px",border:"1px solid var(--border)",borderRadius:12}}
                onClick={googleSignIn}
                disabled={!googleClientId}
              >
                <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                  <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
                  <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
                  <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
                  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
                </svg>
                Sign in with Google
                {!googleClientId && <span style={{fontSize:10,color:"var(--accent)"}}>(missing env config)</span>}
              </button>
            )}
          </div>

          {/* Step 3: Sync */}
          <div style={{padding:"14px 0",borderBottom:"1px solid var(--border)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>Google Drive Sync</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>
              Profiles are saved as <code style={{background:"var(--surface)",padding:"1px 5px",borderRadius:4}}>profile_&#123;id&#125;.json</code> inside a <strong>FlashMaster</strong> folder in your Google Drive root.
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <button
                className="btn btn-primary btn-sm"
                onClick={syncProfileToDrive}
                disabled={!googleUser || gdriveSyncing}
              >
                {gdriveSyncing ? "⏳ Syncing…" : "☁️ Push Profile to Drive"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={restoreFromDrive}
                disabled={!googleUser || gdriveSyncing}
              >
                {gdriveSyncing ? "⏳ Loading…" : "📥 Restore All from Drive"}
              </button>
            </div>
            {gdriveStatus && (
              <div style={{marginTop:10,fontSize:12,padding:"8px 12px",background:"var(--surface)",borderRadius:8,color:gdriveStatus.startsWith("✅")?"var(--green)":gdriveStatus.startsWith("❌")?"var(--red)":"var(--muted)"}}>
                {gdriveStatus}
              </div>
            )}
          </div>

          {/* How it works */}
          <div style={{padding:"14px 0"}}>
            <div style={{fontWeight:700,fontSize:13,marginBottom:8}}>How it works</div>
            {[
              ["1️⃣","Set up Google Cloud","Create an OAuth 2.0 Client ID with your app domain as an Authorized JavaScript Origin. No image search API keys are needed."],
              ["2️⃣","Sign in","Authenticate with your Google account using OAuth 2.0 (no passwords stored)"],
              ["3️⃣","Push Profile","Exports your current profile's data to Drive as a JSON file in the FlashMaster folder"],
              ["4️⃣","Restore","Downloads all profile JSONs from the FlashMaster folder and imports them into this device"],
            ].map(([icon,title,desc])=>(
              <div key={title} style={{display:"flex",gap:10,marginBottom:10,padding:"10px 12px",background:"var(--surface)",borderRadius:10}}>
                <span style={{fontSize:18}}>{icon}</span>
                <div><div style={{fontWeight:700,fontSize:13}}>{title}</div><div style={{fontSize:11,color:"var(--muted)"}}>{desc}</div></div>
              </div>
            ))}
          </div>
        </>)}
      </div>
      {sec !== "cloud" && (
        <div style={{ marginTop:20 }}>
          <button className="btn btn-primary btn-lg" style={{ width:"100%" }} onClick={() => saveSettings(s)}>💾 Save Settings</button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §20  LEADERBOARD
// ══════════════════════════════════════════════════════════════
function LeaderboardScreen() {
  const { leaderboard } = useApp();
  const sorted = [...leaderboard].sort((a,b)=>b.avgPct-a.avgPct);
  return (
    <div style={{maxWidth:540,margin:"0 auto"}}>
      <div className="h1" style={{marginBottom:20}}>🏆 Leaderboard</div>
      {!sorted.length?<Empty icon="🏆" title="No rankings yet" sub="Complete quizzes to appear here" />:sorted.map((l,i)=>(
        <div key={l.uid} className="card" style={{marginBottom:12,padding:"16px 20px",display:"flex",alignItems:"center",gap:14,border:i===0?"2px solid gold":"1px solid var(--border)"}}>
          <div style={{fontSize:28,width:34,textAlign:"center"}}>{"🥇🥈🥉"[i]||`#${i+1}`}</div>
          <div style={{fontSize:30}}>{l.avatar}</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:16}}>{l.name}</div>
            <div style={{fontSize:12,color:"var(--muted)"}}>{l.quizCount} quizzes · Best: {l.bestPct}%</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:24,color:l.avgPct>=80?"var(--green)":l.avgPct>=60?"var(--primary)":"var(--accent)"}}>{l.avgPct}%</div>
            <div style={{fontSize:11,color:"var(--muted)"}}>avg</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §21  CONTENT SCREENS — Profiles, Subjects, Topics, Subtopics, Questions
// ══════════════════════════════════════════════════════════════
function ProfilesScreen() {
  const { profiles, createProfile, deleteProfile, enterProfile, profileLocks, deviceId,
          googleUser, gdriveStatus, googleSwitchAccount, googleSignIn } = useApp();
  const [modal,  setModal]  = useState(false);
  const [name,   setName]   = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [switchingGoogle, setSwitchingGoogle] = useState(false);
  const [reauthing, setReauthing] = useState(false);
  const [openingProfileId, setOpeningProfileId] = useState("");

  const drivePaused = gdriveStatus?.startsWith("⚠️");

  async function handleReauth() {
    setReauthing(true);
    try {
      await googleSignIn();
    } finally {
      setReauthing(false);
    }
  }

  async function create() {
    if (!name.trim()) return;
    const p = await createProfile(name.trim(), avatar);
    setModal(false);
    setName("");
    setOpeningProfileId(p.id);
    try {
      await enterProfile(p);
    } finally {
      setOpeningProfileId("");
    }
  }

  async function handleSwitchGoogleAccount() {
    setSwitchingGoogle(true);
    try {
      await googleSwitchAccount();
    } finally {
      setSwitchingGoogle(false);
    }
  }

  async function handleOpenProfile(profile) {
    setOpeningProfileId(profile.id);
    try {
      await enterProfile(profile);
    } finally {
      setOpeningProfileId("");
    }
  }

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,background:"var(--bg)"}}>
      {/* App brand */}
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{fontSize:56,marginBottom:8}}>⚡</div>
        <div style={{fontFamily:"var(--syne)",fontWeight:900,fontSize:30,letterSpacing:-.5}}>FlashMaster</div>
        <div style={{color:"var(--muted)",fontSize:12,marginTop:4}}>v6.0 · Dexie.js · SM-2 · Drive Sync</div>
      </div>

      {/* Signed-in user badge */}
      {googleUser && (
        <div style={{padding:"12px 16px",background:"rgba(99,102,241,.1)",border:"1px solid rgba(99,102,241,.25)",borderRadius:12,marginBottom:20,maxWidth:420,width:"100%"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
          {googleUser.picture
            ? <img src={googleUser.picture} alt="" style={{width:32,height:32,borderRadius:"50%",flexShrink:0}} />
            : <div style={{width:32,height:32,borderRadius:"50%",background:"var(--primary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>G</div>
          }
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:800,fontSize:13}}>{googleUser.name}</div>
            <div style={{fontSize:11,color:"var(--green)"}}>✅ {googleUser.email}</div>
          </div>
          {gdriveStatus && (
            <div style={{fontSize:10,color:gdriveStatus.startsWith("✅")?"var(--green)":gdriveStatus.startsWith("⏳")?"var(--accent)":"var(--muted)",maxWidth:120,textAlign:"right",lineHeight:1.3}}>
              {gdriveStatus}
            </div>
          )}
          </div>
          <div style={{marginTop:12,display:"flex",gap:8,flexDirection:"column"}}>
            {drivePaused && (
              <button
                className="btn btn-primary btn-sm"
                style={{width:"100%"}}
                onClick={handleReauth}
                disabled={reauthing}
              >
                {reauthing ? "Opening Google sign-in…" : "🔄 Re-authenticate Google Drive"}
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              style={{width:"100%"}}
              onClick={handleSwitchGoogleAccount}
              disabled={switchingGoogle}
            >
              {switchingGoogle ? "Opening Google sign-in..." : "Use Another Google Account"}
            </button>
          </div>
        </div>
      )}

      <div style={{width:"100%",maxWidth:420}}>
        {!profiles.length ? (
          <Empty
            icon="👤"
            title="No profiles yet"
            sub="Create your first profile to start learning"
            action={<button className="btn btn-primary btn-lg" onClick={()=>setModal(true)}>+ Create Profile</button>}
          />
        ) : (
          <>
            <div style={{marginBottom:14}}>
              {profiles.map(p=>(
                <div key={p.id} className="card"
                  style={{display:"flex",alignItems:"center",gap:14,padding:"16px 18px",marginBottom:10,cursor:profileLocks[p.id] && isProfileLockActive(profileLocks[p.id]) && profileLocks[p.id].deviceId !== deviceId ? "not-allowed" : "pointer",opacity:profileLocks[p.id] && isProfileLockActive(profileLocks[p.id]) && profileLocks[p.id].deviceId !== deviceId ? 0.7 : 1}}
                  onClick={() => {
                    const lock = profileLocks[p.id];
                    const blocked = lock && isProfileLockActive(lock) && lock.deviceId !== deviceId;
                    if (!blocked && openingProfileId !== p.id) handleOpenProfile(p);
                  }}>
                  <div style={{fontSize:34}}>{p.avatar}</div>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:17}}>{p.name}</div>
                    <div style={{fontSize:12,color:profileLocks[p.id] && isProfileLockActive(profileLocks[p.id]) && profileLocks[p.id].deviceId !== deviceId ? "var(--red)" : "var(--muted)"}}>
                      {openingProfileId === p.id ? "Opening profile..." : profileLocks[p.id] && isProfileLockActive(profileLocks[p.id]) && profileLocks[p.id].deviceId !== deviceId ? getProfileLockLabel(profileLocks[p.id]) : "Tap to enter"}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm"
                    onClick={e=>{e.stopPropagation();if(window.confirm(`Delete "${p.name}"?`))deleteProfile(p.id);}}>🗑</button>
                  <div style={{fontSize:20,color:"var(--muted)"}}>›</div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button className="btn btn-primary btn-lg" style={{flex:1}} onClick={()=>setModal(true)}>+ New Profile</button>
            </div>
          </>
        )}
      </div>

      {modal&&<Modal title="New Profile" onClose={()=>setModal(false)}>
        <div style={{marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:13,marginBottom:8}}>Choose Avatar</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {AVATARS.map(a=>(
              <div key={a} onClick={()=>setAvatar(a)}
                style={{fontSize:28,cursor:"pointer",padding:8,borderRadius:10,
                  border:`2px solid ${a===avatar?"var(--primary)":"transparent"}`,
                  background:a===avatar?"var(--surface)":"transparent"}}>
                {a}
              </div>
            ))}
          </div>
        </div>
        <input className="input" placeholder="Your name…" value={name}
          onChange={e=>setName(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&create()} autoFocus style={{marginBottom:14}}/>
        <button className="btn btn-primary btn-lg" style={{width:"100%"}}
          onClick={create} disabled={!name.trim()}>Create Profile</button>
      </Modal>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §21b  GOOGLE LOGIN SCREEN (mandatory first screen)
// ══════════════════════════════════════════════════════════════
function GoogleLoginScreen() {
  const { googleClientId, googleSignIn, googleAuthChecking, checkGoogleSignInStatus } = useApp();
  const [signing, setSigning] = useState(false);
  const busy = signing || googleAuthChecking;

  useEffect(() => {
    checkGoogleSignInStatus();
  }, [checkGoogleSignInStatus]);

  async function handleSignIn() {
    setSigning(true);
    try {
      await googleSignIn();
    } finally {
      setSigning(false);
    }
  }

  const GoogleLogo = () => (
    <svg width="22" height="22" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
    </svg>
  );

  return (
    <div style={{
      minHeight:"100vh", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center",
      padding:24, background:"var(--bg)",
    }}>
      <div style={{textAlign:"center",marginBottom:22}}>
        <div style={{fontFamily:"var(--syne)",fontWeight:900,fontSize:34,letterSpacing:-1}}>
          Flash Master
        </div>
      </div>

      <div className="card" style={{width:"100%",maxWidth:460,padding:30}}>
        <div style={{fontSize:11,fontWeight:800,color:"var(--muted)",textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>
          Account Access
        </div>
        <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:26,letterSpacing:-.5,marginBottom:8}}>
          Sign in to continue
        </div>
        <div style={{fontSize:14,color:"var(--muted)",lineHeight:1.55,marginBottom:22}}>
          Use your Google account to access Flash Master.
        </div>
        {googleAuthChecking && !signing && (
          <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>
            Checking whether your Google sign-in is still active...
          </div>
        )}

        <button
          className="btn btn-primary btn-lg"
          style={{width:"100%",gap:12,fontSize:15}}
          onClick={handleSignIn}
          disabled={!googleClientId || busy}
        >
          {busy ? (
            <span style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{display:"inline-block",width:16,height:16,border:"2px solid rgba(255,255,255,.3)",borderTopColor:"white",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>
              {signing ? "Signing in..." : "Checking sign-in..."}
            </span>
          ) : (
            <><GoogleLogo /> Sign in with Google</>
          )}
        </button>
      </div>

      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>
    </div>
  );
}
function SubjectsScreen() {
  const { subjects, createSubject, deleteSubject, navigate, importCSVToSubject, showToast } = useApp();
  const [modal,     setModal]    = useState(false);
  const [csvSubId,  setCSVSubId] = useState(null);
  const [name,      setName]     = useState("");
  const [log,       setLog]      = useState("");

  async function create() { if(!name.trim())return; await createSubject(name.trim()); setName(""); setModal(false); }

  async function handleImport(sid, topicName, rows) {
    try {
      const r = await importCSVToSubject(sid, topicName, rows);
      setLog(`✅ "${r.topicName}" · ${r.subtopicCount} subtopics · ${r.questionCount} questions`);
      setTimeout(()=>setLog(""),8000);
    } catch (e) {
      console.error("Question import failed:", e);
      showToast(`Import failed: ${e?.message||e}`, "error");
    }
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div className="h1">📚 Subjects</div>
        <button className="btn btn-primary" onClick={()=>setModal(true)}>+ Subject</button>
      </div>
      {log&&<div style={{marginBottom:12,padding:"10px 14px",background:"var(--green)12",border:"1px solid var(--green)30",borderRadius:10,fontSize:13,color:"var(--green)",fontWeight:700}}>{log}</div>}
      {!subjects.length?<Empty icon="📚" title="No subjects yet" sub="Create one, then import questions" action={<button className="btn btn-primary btn-lg" onClick={()=>setModal(true)}>+ Add Subject</button>}/>:subjects.map(s=>(
        <div key={s.id} className="card" style={{marginBottom:12,padding:"16px 20px"}}>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <div style={{fontSize:30}}>📗</div>
            <div style={{flex:1,cursor:"pointer"}} onClick={()=>navigate("topics",{subjectId:s.id})}>
              <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:17}}>{s.name}</div>
              <div style={{fontSize:12,color:"var(--muted)"}}>{s.language||"English"}</div>
            </div>
            <div style={{display:"flex",gap:6}}>
              <button className="btn btn-ghost btn-sm" onClick={e=>{e.stopPropagation();setCSVSubId(s.id);}} title="Import Questions">📥</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>navigate("topics",{subjectId:s.id})}>›</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>{if(window.confirm(`Delete "${s.name}"?`))deleteSubject(s.id);}}>🗑</button>
            </div>
          </div>
        </div>
      ))}
      {modal&&<Modal title="New Subject" onClose={()=>setModal(false)}>
        <input className="input" placeholder="Subject name…" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()} autoFocus style={{marginBottom:14}}/>
        <button className="btn btn-primary btn-lg" style={{width:"100%"}} onClick={create} disabled={!name.trim()}>Create</button>
      </Modal>}
      {csvSubId&&<CSVImportModal subjectId={csvSubId} onClose={()=>setCSVSubId(null)} onImport={handleImport}/>}
    </div>
  );
}

function TopicsScreen() {
  const { topics, subtopics, questions, createTopic, deleteTopic, navigate, nav } = useApp();
  const [modal,setModal]=useState(false); const [name,setName]=useState("");
  const myT=topics.filter(t=>t.sid===nav.subjectId);
  async function create(){if(!name.trim())return;await createTopic(nav.subjectId,name.trim());setName("");setModal(false);}
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div className="h1">📖 Topics</div>
        <button className="btn btn-primary" onClick={()=>setModal(true)}>+ Topic</button>
      </div>
      {!myT.length?<Empty icon="📖" title="No topics" sub="Create a topic or import questions to auto-create" action={<button className="btn btn-primary btn-lg" onClick={()=>setModal(true)}>+ Topic</button>}/>:myT.map(t=>{
        const stids=subtopics.filter(s=>s.tid===t.id).map(s=>s.id);
        const qs=questions.filter(q=>stids.includes(q.stid));
        const textCount=qs.filter(q=>!isImageQuestion(q)).length;
        const imageCount=qs.filter(q=>isImageQuestion(q)).length;
        return(
          <div key={t.id} className="card" style={{marginBottom:12,padding:"16px 20px"}}>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
              <div style={{fontSize:26}}>📂</div>
              <div style={{flex:1}}>
                <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:16}}>{t.name}</div>
                <div style={{fontSize:12,color:"var(--muted)"}}>{stids.length} subtopics · {qs.length} questions · {textCount} text · {imageCount} image</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button className="btn btn-primary btn-sm" onClick={()=>navigate("subtopics",{topicId:t.id,subjectId:nav.subjectId})}>Open</button>
              {qs.length>0&&<button className="btn btn-ghost btn-sm" onClick={()=>navigate("quiz",{topicId:t.id,subjectId:nav.subjectId,questionMode:"mixed"})}>Quiz</button>}
              {imageCount>0&&<button className="btn btn-ghost btn-sm" onClick={()=>navigate("quiz",{topicId:t.id,subjectId:nav.subjectId,questionMode:"image"})}>Image Quiz</button>}
              <button className="btn btn-ghost btn-sm" onClick={()=>{if(window.confirm(`Delete "${t.name}"?`))deleteTopic(t.id);}}>🗑</button>
            </div>
          </div>
        );
      })}
      {modal&&<Modal title="New Topic" onClose={()=>setModal(false)}><input className="input" placeholder="Topic name…" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()} autoFocus style={{marginBottom:14}}/><button className="btn btn-primary btn-lg" style={{width:"100%"}} onClick={create} disabled={!name.trim()}>Create</button></Modal>}
    </div>
  );
}

function SubtopicsScreen() {
  const { subtopics, questions, topics, createSubtopic, deleteSubtopic, resetSubtopicProgress, navigate, nav, progMap, getWeakLessons, SRS } = useApp();
  const [modal,setModal]=useState(false);const [name,setName]=useState("");
  const topic=topics.find(t=>t.id===nav.topicId);
  const myST=subtopics.filter(s=>s.tid===nav.topicId);
  async function create(){if(!name.trim())return;await createSubtopic(nav.topicId,name.trim());setName("");setModal(false);}
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div className="h1">{topic?.name||"Subtopics"}</div>
        <button className="btn btn-primary" onClick={()=>setModal(true)}>+ Subtopic</button>
      </div>
      {!myST.length?<Empty icon="📑" title="No subtopics" sub="Create or import questions" action={<button className="btn btn-primary btn-lg" onClick={()=>setModal(true)}>+ Subtopic</button>}/>:myST.map(st=>{
        const qs=questions.filter(q=>q.stid===st.id);
        const progs=qs.map(q=>progMap.get(q.id)).filter(Boolean);
        const mastered=progs.filter(p=>p.status==="mastered").length;
        const due=progs.filter(p=>SRS.isDue(p)).length;
        const acc=progs.length>0?Math.round(progs.reduce((a,p)=>a+(p.totalShown>0?p.correctCount/p.totalShown:0),0)/progs.length*100):null;
        const weak=getWeakLessons().find(w=>w.subtopic.id===st.id);
        return(
          <div key={st.id} className="card" style={{marginBottom:12,padding:"16px 20px"}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:10}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:16}}>{st.name}</div>
                <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>
                  {qs.length} cards · {mastered} mastered{due>0?<span style={{color:"var(--accent)"}}> · {due} due</span>:""}
                  {weak&&<span style={{color:"var(--red)"}}> · ⚠️ weak</span>}
                </div>
              </div>
              {acc!==null&&<div style={{textAlign:"right"}}><div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:18,color:acc>=70?"var(--green)":acc>=50?"var(--accent)":"var(--red)"}}>{acc}%</div><div style={{fontSize:10,color:"var(--muted)"}}>accuracy</div></div>}
            </div>
            <PBar value={mastered} max={qs.length} height={5}/>
            <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
              {qs.length>0&&<button className="btn btn-primary btn-sm" onClick={()=>navigate("flash",{subtopicId:st.id})}>🃏 Flash</button>}
              {qs.length>0&&<button className="btn btn-ghost btn-sm" onClick={()=>navigate("quiz",{subtopicId:st.id})}>📝 Quiz</button>}
              {weak&&<button className="btn btn-accent btn-sm" onClick={()=>navigate("flash",{subtopicId:st.id,preloadedQs:weak.questions})}>⚠️ Weak</button>}
              <button className="btn btn-ghost btn-sm" onClick={()=>navigate("questions",{subtopicId:st.id})}>📋 Qs</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>{if(window.confirm("Reset?"))resetSubtopicProgress(st.id);}}>↩</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>{if(window.confirm(`Delete "${st.name}"?`))deleteSubtopic(st.id);}}>🗑</button>
            </div>
          </div>
        );
      })}
      {modal&&<Modal title="New Subtopic" onClose={()=>setModal(false)}><input className="input" placeholder="Subtopic name…" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()} autoFocus style={{marginBottom:14}}/><button className="btn btn-primary btn-lg" style={{width:"100%"}} onClick={create} disabled={!name.trim()}>Create</button></Modal>}
    </div>
  );
}

function QuestionsScreen() {
  const { questions, subtopics, deleteQuestion, nav, navigate } = useApp();
  const myQs=questions.filter(q=>q.stid===nav.subtopicId);
  const st=subtopics.find(s=>s.id===nav.subtopicId);
  const useVirtual = myQs.length > 100;
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div className="h1">{st?.name||"Questions"}</div>
        <button className="btn btn-ghost" onClick={()=>navigate("subjects")}>Import Questions</button>
      </div>
      {!myQs.length?<Empty icon="❓" title="No questions" sub="Questions are loaded from CSV or ZIP image imports" action={<button className="btn btn-primary btn-lg" onClick={()=>navigate("subjects")}>Go To Subjects</button>}/>:( 
        useVirtual?(
          <VirtualList items={myQs} itemHeight={92} containerHeight={520} renderItem={(q)=>{
            const label=getQuestionLabel(q);
            const answerPreview=getQuestionAnswerPreview(q);
            return(
            <div className="card" style={{margin:"2px 0",padding:"10px 14px",height:88}}>
              <div style={{display:"flex",gap:8,marginBottom:4,flexWrap:"wrap"}}><Badge v={q.difficulty==="easy"?"green":q.difficulty==="hard"?"red":"accent"}>{q.difficulty}</Badge><Badge v="primary">{normalizeQuestionType(q)}</Badge></div>
              <div style={{fontWeight:700,fontSize:13,lineHeight:1.3,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{label}</div>
              <div style={{fontSize:12,color:"var(--green)",marginTop:4,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{answerPreview}</div>
            </div>
          );}}/>
        ):(
          myQs.map(q=>{
            const label=getQuestionLabel(q);
            const answerPreview=getQuestionAnswerPreview(q);
            return(
            <div key={q.id} className="card" style={{marginBottom:10,padding:"14px 18px"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",gap:6,marginBottom:4,flexWrap:"wrap"}}><Badge v={q.difficulty==="easy"?"green":q.difficulty==="hard"?"red":"accent"}>{q.difficulty}</Badge><Badge v="primary">{normalizeQuestionType(q)}</Badge></div>
                  <div style={{fontWeight:700,fontSize:14,marginBottom:3}}>{label.slice(0,90)}{label.length>90?"…":""}</div>
                  <div style={{fontSize:12,color:"var(--green)"}}>{answerPreview}</div>
                  {q.explanation&&<div style={{fontSize:11,color:"var(--primary)",marginTop:3}}>💡 {q.explanation.slice(0,60)}</div>}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={()=>{if(window.confirm("Delete?"))deleteQuestion(q.id);}}>🗑</button>
              </div>
            </div>
          );})
        )
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §22  DASHBOARD + PLANNER
// ══════════════════════════════════════════════════════════════
function Dashboard() {
  const { currentProfile, streak, getTodayDP, dailyPlan, flashProg, questions, quizAttempts, getWeakLessons, navigate, SRS } = useApp();
  const dp = getTodayDP();
  const weakLessons = getWeakLessons();
  const due   = flashProg.filter(f=>SRS.isDue(f)&&f.status!=="mastered").length;
  const rq    = dailyPlan;
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div className="h1">👋 {currentProfile?.name}</div><div style={{color:"var(--muted)",fontSize:13}}>{new Date().toLocaleDateString("en",{weekday:"long",month:"long",day:"numeric"})}</div></div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <div style={{background:"var(--surface)",borderRadius:12,padding:"8px 14px",display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:20}}>🔥</span><span style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:18}}>{streak.count}</span><span style={{fontSize:12,color:"var(--muted)"}}>day streak</span></div>
          {due>0&&<div style={{background:"#EF444415",border:"1px solid var(--red)30",borderRadius:12,padding:"8px 14px",display:"flex",gap:6,cursor:"pointer"}} onClick={()=>navigate("subjects")}><span>⏰</span><span style={{fontWeight:700,color:"var(--red)"}}>{due} due</span></div>}
        </div>
      </div>
      {rq&&<div style={{display:"flex",gap:12,marginBottom:18,flexWrap:"wrap"}}>
        <GoalRing done={dp.flash||0} goal={rq.flashTarget} label="Flash Goal" icon="🃏" color="var(--primary)"/>
        <GoalRing done={dp.quiz||0} goal={rq.quizTarget} label="Quiz Goal" icon="📝" color="var(--green)"/>
      </div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:12,marginBottom:18}}>
        {[
          {icon:"🃏",val:questions.length,label:"Total Cards"},
          {icon:"⭐",val:flashProg.filter(f=>f.status==="mastered").length,label:"Mastered",col:"var(--green)"},
          {icon:"⏰",val:due,label:"Due Now",col:due>0?"var(--accent)":"var(--green)"},
          {icon:"📖",val:rq?.learningCount||0,label:"Learning",col:"var(--primary)"},
        ].map(s=>(
          <div key={s.label} className="card" style={{padding:"14px 12px",textAlign:"center"}}>
            <div style={{fontSize:22,marginBottom:6}}>{s.icon}</div>
            <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:22,color:s.col||"var(--text)"}}>{s.val}</div>
            <div style={{fontSize:11,color:"var(--muted)",fontWeight:600}}>{s.label}</div>
          </div>
        ))}
      </div>
      <div className="card" style={{padding:20,marginBottom:16}}>
        <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>⚡ Quick Actions</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:10}}>
          {[{icon:"📅",label:"Daily Plan",screen:"planner"},{icon:"🃏",label:"Study",screen:"subjects"},{icon:"📊",label:"Analytics",screen:"analytics"},{icon:"🏆",label:"Leaderboard",screen:"leaderboard"},{icon:"⚙️",label:"Settings",screen:"settings"}].map(a=>(
            <button key={a.label} className="btn btn-ghost" style={{flexDirection:"column",gap:6,height:68,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700}} onClick={()=>navigate(a.screen)}>
              <span style={{fontSize:22}}>{a.icon}</span>{a.label}
            </button>
          ))}
        </div>
      </div>
      {weakLessons.length>0&&(
        <div className="card" style={{padding:20}}>
          <div style={{fontWeight:700,fontSize:15,marginBottom:12,display:"flex",justifyContent:"space-between"}}><span>⚠️ Weak Lessons</span><button className="btn btn-ghost btn-sm" onClick={()=>navigate("analytics")}>All</button></div>
          {weakLessons.slice(0,4).map((wl,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:12,marginBottom:10,padding:"10px 14px",background:"var(--surface)",borderRadius:10}}>
              <div style={{fontSize:20}}>📉</div>
              <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{wl.subtopic.name}</div><div style={{fontSize:11,color:"var(--muted)"}}>{wl.questions.length} cards</div></div>
              <div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:16,color:"var(--red)"}}>{wl.accuracy}%</div>
              <button className="btn btn-accent btn-sm" onClick={()=>navigate("flash",{subtopicId:wl.subtopic.id,preloadedQs:wl.questions})}>Practice</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlannerScreen() {
  const { dailyPlan, getTodayDP, getWeakLessons, navigate } = useApp();
  const dp = getTodayDP();
  const wl = getWeakLessons();
  if (!dailyPlan) return <Empty icon="📅" title="Add cards first" sub="Import questions to generate your plan" />;
  return (
    <div style={{maxWidth:600,margin:"0 auto"}}>
      <div className="h1" style={{marginBottom:4}}>📅 Daily Plan</div>
      <div style={{color:"var(--muted)",fontSize:14,marginBottom:20}}>{new Date().toLocaleDateString("en",{weekday:"long",month:"long",day:"numeric"})}</div>
      <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <GoalRing done={dp.flash||0} goal={dailyPlan.flashTarget} label="Flash Cards" icon="🃏" color="var(--primary)"/>
        <GoalRing done={dp.quiz||0} goal={dailyPlan.quizTarget} label="Quizzes" icon="📝" color="var(--green)"/>
      </div>
      <div className="card" style={{padding:20,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>📊 Queue Status</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,textAlign:"center"}}>
          {[{l:"New",v:dailyPlan.newCount,c:"var(--primary)"},{l:"Due",v:dailyPlan.dueCount,c:"var(--accent)"},{l:"Learning",v:dailyPlan.learningCount,c:"var(--muted)"},{l:"Mastered",v:dailyPlan.masteredCount,c:"var(--green)"}].map(s=>(
            <div key={s.l}><div style={{fontFamily:"var(--syne)",fontWeight:800,fontSize:24,color:s.c}}>{s.v}</div><div style={{fontSize:11,color:"var(--muted)"}}>{s.l}</div></div>
          ))}
        </div>
      </div>
      <div className="card" style={{padding:20}}>
        <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>🎯 Suggested Sessions</div>
        {[
          {icon:"🔁",title:"Review Due Cards",sub:`${dailyPlan.dueCount} cards overdue`,pri:dailyPlan.dueCount>0,screen:"subjects"},
          {icon:"🎯",title:"Weak Lesson Practice",sub:`${dailyPlan.weakCount} weak lesson${dailyPlan.weakCount!==1?"s":""}`,pri:dailyPlan.weakCount>0,screen:"subjects"},
          {icon:"📚",title:"Learn New Cards",sub:`Target: ${dailyPlan.flashTarget} cards`,screen:"subjects"},
          {icon:"✏️",title:"Take a Quiz",sub:`Target: ${dailyPlan.quizTarget} quiz${dailyPlan.quizTarget!==1?"zes":""}`,screen:"subjects"},
        ].map((a,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:"var(--surface)",borderRadius:10,marginBottom:10,cursor:"pointer"}} onClick={()=>navigate(a.screen)}>
            <div style={{fontSize:24}}>{a.icon}</div>
            <div style={{flex:1}}><div style={{fontWeight:700}}>{a.title}</div><div style={{fontSize:12,color:"var(--muted)"}}>{a.sub}</div></div>
            {a.pri&&<span style={{fontSize:11,color:"var(--accent)",fontWeight:700}}>Priority</span>}
            <div style={{fontSize:18,color:"var(--muted)"}}>›</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §23  SIDEBAR + MAIN APP
// ══════════════════════════════════════════════════════════════
function Sidebar({ screen, navigate, currentProfile, streak, due }) {
  const { googleUser, googleSignOut, lastSyncedAt, gdriveSyncing } = useApp();
  const links = [
    {id:"dashboard",icon:"🏠",label:"Home"},
    {id:"planner",icon:"📅",label:"Plan"},
    {id:"subjects",icon:"📚",label:"Study"},
    {id:"analytics",icon:"📊",label:"Analytics"},
    {id:"leaderboard",icon:"🏆",label:"Leaderboard"},
    {id:"settings",icon:"⚙️",label:"Settings"},
  ];
  return (
    <aside className="sidebar">
      <div style={{padding:"20px 14px 12px",borderBottom:"1px solid var(--border)"}}>
        <div style={{fontFamily:"var(--syne)",fontWeight:900,fontSize:17,letterSpacing:-.5}}>⚡ FlashMaster</div>
        <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>v6.0 · Drive Sync</div>
      </div>

      {/* Google user strip */}
      {googleUser && (
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--border)",display:"flex",gap:8,alignItems:"center"}}>
          {googleUser.picture
            ? <img src={googleUser.picture} alt="" style={{width:24,height:24,borderRadius:"50%",border:"2px solid var(--primary)"}}/>
            : <div style={{width:24,height:24,borderRadius:"50%",background:"var(--primary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"white"}}>G</div>
          }
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:800,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{googleUser.name}</div>
            <div style={{fontSize:9,color:gdriveSyncing?"var(--accent)":"var(--green)"}}>
              {gdriveSyncing ? "⏳ Syncing…" : lastSyncedAt ? `☁️ ${lastSyncedAt}` : "☁️ Connected"}
            </div>
          </div>
          <span style={{fontSize:10,color:"var(--muted)",cursor:"pointer",padding:"2px 6px"}} onClick={googleSignOut} title="Sign out">⏏</span>
        </div>
      )}

      {/* Active profile strip */}
      {currentProfile&&<div style={{padding:"10px 14px",borderBottom:"1px solid var(--border)",display:"flex",gap:10,alignItems:"center"}}>
        <span style={{fontSize:26}}>{currentProfile.avatar}</span>
        <div style={{flex:1,minWidth:0}}><div style={{fontWeight:800,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentProfile.name}</div><div style={{fontSize:11,color:"var(--muted)"}}>🔥 {streak.count}</div></div>
        <span style={{fontSize:11,color:"var(--muted)",cursor:"pointer"}} onClick={()=>navigate("profiles")} title="Switch profile">⇄</span>
      </div>}

      <nav style={{padding:"8px 6px",flex:1}}>
        {links.map(l=>(
          <div key={l.id} className={`nav-link ${screen===l.id?"active":""}`} onClick={()=>navigate(l.id)}>
            <span style={{fontSize:19}}>{l.icon}</span><span>{l.label}</span>
            {l.id==="subjects"&&due>0&&<span style={{marginLeft:"auto",background:"var(--red)",color:"white",borderRadius:10,padding:"1px 6px",fontSize:11,fontWeight:800}}>{due}</span>}
          </div>
        ))}
      </nav>
      <div style={{padding:"8px 6px 14px",borderTop:"1px solid var(--border)"}}>
        <a className="nav-link" href={DOCUMENTATION_URL} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}>
          <span style={{fontSize:19}}>📚</span><span>Documentation</span>
        </a>
      </div>
    </aside>
  );
}

function App() {
  const { screen, navigate, currentProfile, toast, focusMode, streak, flashProg, SRS,
          googleUser, lastSyncedAt, gdriveSyncing } = useApp();
  const due = flashProg.filter(f=>SRS.isDue(f)&&f.status!=="mastered").length;

  // Apply CSS custom properties once
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--primary", "#6366F1");
    root.style.setProperty("--green",   "#10B981");
    root.style.setProperty("--red",     "#EF4444");
    root.style.setProperty("--accent",  "#F59E0B");
    root.style.setProperty("--bg",      "#060A16");
    root.style.setProperty("--surface", "#0C1020");
    root.style.setProperty("--card",    "#111825");
    root.style.setProperty("--border",  "#1A2135");
    root.style.setProperty("--text",    "#E2E8F0");
    root.style.setProperty("--muted",   "#5A6882");
    root.style.setProperty("--syne",    "'Syne',sans-serif");
    root.style.setProperty("--nunito",  "'Nunito',sans-serif");
  }, []);

  // Guard: if no Google user, always show login screen
  if (!googleUser || screen === "google_login") return <GoogleLoginScreen />;
  if (screen === "profiles") return <ProfilesScreen />;
  if (!currentProfile) { navigate("profiles"); return null; }

  const SCREENS = {
    dashboard:   <Dashboard />,
    planner:     <PlannerScreen />,
    subjects:    <SubjectsScreen />,
    topics:      <TopicsScreen />,
    subtopics:   <SubtopicsScreen />,
    questions:   <QuestionsScreen />,
    flash:       <FlashScreen />,
    quiz:        <QuizScreen />,
    analytics:   <AnalyticsScreen />,
    leaderboard: <LeaderboardScreen />,
    settings:    <SettingsScreen />,
  };

  const immersive = ["flash","quiz"].includes(screen) && focusMode;

  return (
    <div style={{display:"flex",minHeight:"100vh",background:"var(--bg)",color:"var(--text)",fontFamily:"var(--nunito)"}}>
      {!immersive && <Sidebar screen={screen} navigate={navigate} currentProfile={currentProfile} streak={streak} due={due} />}
      <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column"}}>
        {!immersive&&<header style={{display:"flex",alignItems:"center",gap:10,padding:"12px 22px",borderBottom:"1px solid var(--border)",position:"sticky",top:0,background:"var(--bg)",zIndex:100,backdropFilter:"blur(12px)"}}>
          <div style={{flex:1}}>{screen!=="dashboard"&&<span style={{fontSize:12,color:"var(--muted)",cursor:"pointer"}} onClick={()=>navigate("dashboard")}>‹ Dashboard</span>}</div>
          {/* Live Drive sync indicator */}
          <div title={lastSyncedAt?`Last synced: ${lastSyncedAt}`:"Not yet synced"}
            style={{fontSize:10,color:gdriveSyncing?"var(--accent)":"var(--green)",display:"flex",alignItems:"center",gap:3,opacity:.8}}>
            <span style={gdriveSyncing?{animation:"spin 1s linear infinite",display:"inline-block"}:{}}>{gdriveSyncing?"⏳":"☁️"}</span>
            <span>{gdriveSyncing?"Syncing…":lastSyncedAt||""}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={()=>navigate("planner")}>📅</button>
          <button className="btn btn-ghost btn-sm" onClick={()=>navigate("analytics")}>📊</button>
          <button className="btn btn-ghost btn-sm" onClick={()=>navigate("settings")}>⚙️</button>
        </header>}
        <main style={{flex:1,padding:["flash","quiz"].includes(screen)?"14px 12px":"22px",overflowX:"hidden"}}>
          {SCREENS[screen] || <Dashboard />}
        </main>
      </div>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// §24  ROOT + GLOBAL STYLES
// ══════════════════════════════════════════════════════════════
export default function FlashMasterV5_1_Production() {
  return (
    <AppProvider>
      <App />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800;900&family=Nunito:wght@400;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:var(--bg);color:var(--text);font-family:var(--nunito,sans-serif);font-size:var(--base-font,15px);}
        .h1{font-family:var(--syne);font-weight:900;font-size:24px;letter-spacing:-.5px;}
        .h2{font-family:var(--syne);font-weight:800;font-size:18px;}
        .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px 20px;transition:box-shadow .2s;}
        .card:hover{box-shadow:0 4px 24px rgba(0,0,0,.3);}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px;backdrop-filter:blur(4px);}
        .modal{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:26px;width:100%;max-height:92vh;overflow-y:auto;animation:slideUp .22s ease;}
        @keyframes slideUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
        .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;border-radius:10px;cursor:pointer;font-family:var(--nunito);font-weight:800;font-size:14px;padding:10px 18px;transition:all .15s;white-space:nowrap;}
        .btn:disabled{opacity:.4;cursor:not-allowed;}
        .btn-primary{background:var(--primary);color:white;}.btn-primary:hover:not(:disabled){background:#5355e0;transform:translateY(-1px);}
        .btn-ghost{background:var(--surface);color:var(--text);border:1px solid var(--border);}.btn-ghost:hover:not(:disabled){background:var(--border);}
        .btn-accent{background:rgba(245,158,11,.15);color:var(--accent);border:1px solid rgba(245,158,11,.3);}.btn-accent:hover:not(:disabled){background:rgba(245,158,11,.3);}
        .btn-sm{padding:6px 12px;font-size:12px;border-radius:8px;}
        .btn-lg{padding:14px 24px;font-size:16px;border-radius:14px;}
        .active-mode{background:var(--primary)20!important;color:var(--primary)!important;border-color:var(--primary)40!important;}
        .input{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-family:var(--nunito);font-size:15px;transition:border .15s;outline:none;resize:vertical;}
        .input:focus{border-color:var(--primary);}
        .input-correct{border-color:var(--green)!important;background:rgba(16,185,129,.08)!important;}
        .input-wrong{border-color:var(--red)!important;background:rgba(239,68,68,.08)!important;}
        .pbar{width:100%;background:var(--border);border-radius:99px;overflow:hidden;height:6px;}
        .pbar-fill{height:100%;background:var(--primary);border-radius:99px;transition:width .4s ease;}
        .pbar-fill.green{background:var(--green);}.pbar-fill.accent{background:var(--accent);}
        .sidebar{width:210px;min-width:210px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;height:100vh;position:sticky;top:0;overflow-y:auto;}
        .nav-link{display:flex;align-items:center;gap:11px;padding:10px 14px;border-radius:12px;cursor:pointer;font-weight:700;font-size:14px;margin:2px 5px;transition:all .15s;color:var(--muted);}
        .nav-link:hover{background:var(--card);color:var(--text);}
        .nav-link.active{background:rgba(99,102,241,.15);color:var(--primary);}
        .tab-bar{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;}
        .tab-btn{flex-shrink:0;padding:8px 16px;border-radius:20px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-family:var(--nunito);font-weight:700;font-size:13px;transition:all .15s;white-space:nowrap;}
        .tab-btn.active{background:var(--primary);color:white;border-color:var(--primary);}
        .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:800;}
        .badge-primary{background:rgba(99,102,241,.2);color:var(--primary);}
        .badge-green{background:rgba(16,185,129,.2);color:var(--green);}
        .badge-red{background:rgba(239,68,68,.2);color:var(--red);}
        .badge-accent{background:rgba(245,158,11,.2);color:var(--accent);}
        .badge-muted{background:var(--surface);color:var(--muted);}
        /* Flashcard */
        .flashcard{perspective:1200px;min-height:240px;cursor:pointer;user-select:none;}
        .flashcard-inner{position:relative;width:100%;min-height:240px;transform-style:preserve-3d;transition:transform .55s cubic-bezier(.4,.2,.2,1);}
        .flashcard-inner.flipped{transform:rotateY(180deg);}
        .flashcard-front,.flashcard-back{position:absolute;width:100%;min-height:240px;backface-visibility:hidden;background:var(--card);border:1px solid var(--border);border-radius:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;}
        .flashcard-front:hover,.flashcard-back:hover{box-shadow:0 8px 40px rgba(99,102,241,.12);}
        .flashcard-back{transform:rotateY(180deg);border-color:rgba(16,185,129,.3);}
        /* Quiz options */
        .quiz-opt{width:100%;text-align:left;padding:13px 18px;background:var(--surface);border:2px solid var(--border);border-radius:12px;cursor:pointer;font-family:var(--nunito);font-weight:700;font-size:14px;color:var(--text);transition:all .15s;}
        .quiz-opt:hover:not(:disabled){border-color:var(--primary);background:rgba(99,102,241,.08);}
        .quiz-opt.selected{border-color:var(--primary);background:rgba(99,102,241,.12);}
        .quiz-opt.correct{border-color:var(--green);background:rgba(16,185,129,.12);color:var(--green);}
        .quiz-opt.wrong{border-color:var(--red);background:rgba(239,68,68,.12);color:var(--red);}
        .quiz-opt.correct-missed{border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.06);}
        .tf-opt{text-align:center!important;}
        /* Match / Order */
        .match-term,.order-item{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--surface);border:2px solid var(--border);border-radius:10px;font-weight:700;font-size:13px;cursor:grab;transition:all .15s;}
        .match-target{padding:10px 14px;background:var(--surface);border:2px dashed var(--border);border-radius:10px;font-size:13px;min-height:42px;transition:all .15s;}
        .drag-over{border-color:var(--primary)!important;background:rgba(99,102,241,.08)!important;}
        .used{border-style:solid!important;border-color:rgba(16,185,129,.5)!important;}
        .dragging{opacity:.4;transform:scale(.97);}
        .match-term.correct,.order-item.correct{border-color:var(--green);background:rgba(16,185,129,.1);}
        .match-term.wrong,.order-item.wrong{border-color:var(--red);background:rgba(239,68,68,.1);}
        .drag-handle{color:var(--muted);cursor:grab;}
        .order-num{width:22px;height:22px;background:var(--border);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;}
        /* Cloze */
        .cloze-input{background:transparent;border:none;border-bottom:2px solid var(--primary);padding:2px 6px;font-family:var(--syne);font-weight:700;color:var(--text);outline:none;text-align:center;}
        .cloze-input.correct{border-bottom-color:var(--green);color:var(--green);}
        .cloze-input.wrong{border-bottom-color:var(--red);color:var(--red);}
        /* Rating buttons */
        .rate-btn{padding:12px 6px;border-radius:12px;border:2px solid rgba(0,0,0,.1);background:rgba(99,102,241,.05);color:var(--rc,var(--primary));cursor:pointer;font-family:var(--nunito);font-weight:800;font-size:13px;display:flex;flex-direction:column;align-items:center;gap:4px;border-color:color-mix(in srgb,var(--rc) 30%,transparent);transition:all .15s;}
        .rate-btn:hover{background:color-mix(in srgb,var(--rc) 20%,transparent);transform:translateY(-2px);}
        /* Anim */
        .pulsing{animation:pulse .8s ease infinite;}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(.97)}}
        /* Mobile */
        @media(max-width:768px){.sidebar{display:none;}.h1{font-size:20px;}.flashcard-front,.flashcard-back,.flashcard-inner{min-height:190px;}}
      `}</style>
    </AppProvider>
  );
}
