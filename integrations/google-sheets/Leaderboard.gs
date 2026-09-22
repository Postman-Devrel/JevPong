/* Jev Pong storage adapter. Deploy one copy per leaderboard spreadsheet.
 * See docs/leaderboard.md. This code is for Google Apps Script, not the browser.
 */
var JEV_COLUMNS = [
  "match_id",
  "player_id",
  "nickname",
  "difficulty",
  "version",
  "provider",
  "strategy",
  "started_at_ms",
  "status",
  "completed_at",
  "duration_ms",
  "human_score",
  "jev_score",
  "live_decisions",
  "fallback_decisions",
  "mock_decisions",
  "strategy_changed",
  "ranked",
  "reason",
  "hidden",
];

// Run once manually after setting SPREADSHEET_ID and LEADERBOARD_SECRET in Script Properties.
function setupLeaderboard() {
  var properties = PropertiesService.getScriptProperties();
  if ((properties.getProperty("LEADERBOARD_SECRET") || "").length < 32)
    throw new Error(
      "Set a random LEADERBOARD_SECRET of at least 32 characters first.",
    );
  var book = SpreadsheetApp.openById(properties.getProperty("SPREADSHEET_ID"));
  var sheet = book.getSheetByName("Matches") || book.insertSheet("Matches");
  if (sheet.getLastRow() > 0) {
    jevSheet();
    return;
  }
  sheet.getRange(1, 1, 1, JEV_COLUMNS.length).setValues([JEV_COLUMNS]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, JEV_COLUMNS.length).setFontWeight("bold");
}

function jevSheet() {
  var id =
    PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  var sheet = SpreadsheetApp.openById(id).getSheetByName("Matches");
  if (
    !sheet ||
    JSON.stringify(
      sheet.getRange(1, 1, 1, JEV_COLUMNS.length).getValues()[0],
    ) !== JSON.stringify(JEV_COLUMNS)
  )
    throw new Error("invalid_sheet_headers");
  return sheet;
}
function jevRows(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, JEV_COLUMNS.length)
    .getValues()
    .map(function (values) {
      var row = {};
      JEV_COLUMNS.forEach(function (key, i) {
        row[key] = values[i];
      });
      return row;
    });
}
function jevValues(row) {
  return JEV_COLUMNS.map(function (key) {
    return row[key] === undefined ? "" : row[key];
  });
}
function jevHidden(row) {
  return row.hidden === true || String(row.hidden).toLowerCase() === "true";
}
function jevRanked(row) {
  return row.ranked === true || String(row.ranked).toLowerCase() === "true";
}
function jevCompare(a, b) {
  return (
    Number(a.duration_ms) - Number(b.duration_ms) ||
    String(a.completed_at).localeCompare(String(b.completed_at)) ||
    String(a.match_id).localeCompare(String(b.match_id))
  );
}
function jevBest(rows, difficulty, version) {
  var best = {};
  rows.forEach(function (row) {
    if (
      row.status !== "completed" ||
      !jevRanked(row) ||
      jevHidden(row) ||
      Number(row.difficulty) !== difficulty ||
      row.version !== version
    )
      return;
    var old = best[row.player_id];
    if (!old || jevCompare(row, old) < 0) best[row.player_id] = row;
  });
  return Object.keys(best)
    .map(function (key) {
      return best[key];
    })
    .sort(jevCompare);
}
function jevPublicEntry(row, rank) {
  return {
    matchId: String(row.match_id),
    playerName: String(row.nickname),
    rank: rank,
    durationMs: Number(row.duration_ms),
    humanScore: Number(row.human_score),
    aiScore: Number(row.jev_score),
    completedAt: String(row.completed_at),
  };
}
function jevBoard(rows, payload) {
  var best = jevBest(rows, payload.difficulty, payload.version);
  var personalBest = null;
  var rank = 0;
  var entries = best.map(function (row, i) {
    if (i === 0 || Number(row.duration_ms) !== Number(best[i - 1].duration_ms))
      rank = i + 1;
    var entry = jevPublicEntry(row, rank);
    if (row.player_id === payload.playerId) personalBest = entry;
    return entry;
  });
  return {
    difficulty: payload.difficulty,
    entries: entries.slice(0, 20),
    totalPlayers: best.length,
    personalBest: personalBest,
    updatedAt: new Date().toISOString(),
  };
}
function jevClaims(row) {
  return {
    matchId: row.match_id,
    playerId: row.player_id,
    playerName: row.nickname,
    difficulty: Number(row.difficulty),
    version: row.version,
    provider: row.provider,
    strategy: row.strategy,
    startedAt: Number(row.started_at_ms),
  };
}
function jevResult(rows, row) {
  var board = jevBoard(rows, jevClaims(row));
  var best = jevBest(rows, Number(row.difficulty), row.version);
  var ranked = jevRanked(row) && !jevHidden(row);
  // Position of this run against everybody else's personal best; a slower repeat
  // does not overwrite the player's faster best on the public board.
  var rank = ranked
    ? 1 +
      best.filter(function (entry) {
        return (
          entry.player_id !== row.player_id &&
          Number(entry.duration_ms) < Number(row.duration_ms)
        );
      }).length
    : null;
  return {
    matchId: row.match_id,
    ranked: ranked,
    reason: jevHidden(row) ? "hidden" : row.reason || null,
    rank: rank,
    personalBest:
      !!board.personalBest && board.personalBest.matchId === row.match_id,
    durationMs: Number(row.duration_ms),
    board: board,
  };
}

function doPost(event) {
  var lock;
  try {
    if (!event || !event.postData || event.postData.contents.length > 16000)
      throw new Error("invalid_request");
    var request = JSON.parse(event.postData.contents);
    var secret =
      PropertiesService.getScriptProperties().getProperty("LEADERBOARD_SECRET");
    if (!secret || secret.length < 32 || request.secret !== secret)
      throw new Error("unauthorized");
    var payload = request.payload;
    if (
      !payload ||
      [1, 2, 3].indexOf(payload.difficulty) === -1 ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(payload.version) ||
      !/^[a-f0-9-]{36}$/.test(payload.playerId)
    )
      throw new Error("invalid_request");
    if (["board", "start", "finish"].indexOf(request.action) === -1)
      throw new Error("invalid_request");

    // Shared lock is effective across all Next.js instances. Start/finish retries
    // look up the same match ID and never append a second row.
    lock = LockService.getScriptLock();
    if (!lock.tryLock(4000)) throw new Error("busy");
    var sheet = jevSheet();
    var rows = jevRows(sheet);
    var data;
    if (request.action === "board") {
      data = jevBoard(rows, payload);
    } else {
      if (
        !/^[a-zA-Z0-9_-]{43}$/.test(payload.matchId) ||
        typeof payload.playerName !== "string" ||
        payload.playerName.length < 1 ||
        payload.playerName.length > 18 ||
        /^[=+@\-\t\r\n]/.test(payload.playerName) ||
        !Number.isInteger(payload.startedAt)
      )
        throw new Error("invalid_request");
      var index = rows.findIndex(function (row) {
        return row.match_id === payload.matchId;
      });
      var row = index === -1 ? null : rows[index];
      if (
        row &&
        (row.player_id !== payload.playerId ||
          Number(row.difficulty) !== payload.difficulty ||
          row.version !== payload.version ||
          row.nickname !== payload.playerName)
      )
        throw new Error("result_conflict");
      if (request.action === "start") {
        if (!row) {
          row = {
            match_id: payload.matchId,
            player_id: payload.playerId,
            nickname: payload.playerName,
            difficulty: payload.difficulty,
            version: payload.version,
            provider: payload.provider,
            strategy: payload.strategy,
            started_at_ms: payload.startedAt,
            status: "started",
            hidden: false,
          };
          sheet.appendRow(jevValues(row));
          SpreadsheetApp.flush();
        }
        data = jevClaims(row);
      } else {
        if (!row) throw new Error("match_missing");
        if (row.status === "completed") {
          if (
            Number(row.duration_ms) !== payload.durationMs ||
            Number(row.human_score) !== payload.humanScore ||
            Number(row.jev_score) !== payload.aiScore ||
            Number(row.live_decisions) !== payload.liveDecisions ||
            Number(row.fallback_decisions) !== payload.fallbackDecisions ||
            Number(row.mock_decisions) !== payload.mockDecisions ||
            row.strategy_changed !== payload.strategyChanged
          )
            throw new Error("result_conflict");
        } else {
          row.status = "completed";
          row.completed_at = payload.completedAt;
          row.duration_ms = payload.durationMs;
          row.human_score = payload.humanScore;
          row.jev_score = payload.aiScore;
          row.live_decisions = payload.liveDecisions;
          row.fallback_decisions = payload.fallbackDecisions;
          row.mock_decisions = payload.mockDecisions;
          row.strategy_changed = payload.strategyChanged;
          row.ranked = payload.ranked;
          row.reason = payload.reason || "";
          sheet
            .getRange(index + 2, 1, 1, JEV_COLUMNS.length)
            .setValues([jevValues(row)]);
          SpreadsheetApp.flush();
        }
        data = jevResult(rows, row);
      }
    }
    return jevJson({ ok: true, data: data });
  } catch (error) {
    var allowed = [
      "unauthorized",
      "invalid_request",
      "busy",
      "match_missing",
      "result_conflict",
    ];
    return jevJson({
      ok: false,
      error:
        allowed.indexOf(error.message) >= 0
          ? error.message
          : "storage_unavailable",
    });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}
function jevJson(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
