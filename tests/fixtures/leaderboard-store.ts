import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Executes the actual Apps Script adapter against a small Sheets test double. */
export function sheetStore(secret = "test-secret-".repeat(5)) {
  const rows: unknown[][] = [];
  let busy = false;
  let locked = false;
  let sheetExists = false;
  const sheet = {
    getLastRow: () => rows.length,
    getRange: (row: number, col: number, height: number, width: number) => ({
      getValues: () =>
        Array.from({ length: height }, (_, i) =>
          Array.from(
            { length: width },
            (_, j) => rows[row - 1 + i]?.[col - 1 + j] ?? "",
          ),
        ),
      setValues: (values: unknown[][]) => {
        values.forEach((valuesRow, i) => {
          rows[row - 1 + i] ??= [];
          valuesRow.forEach((value, j) => {
            rows[row - 1 + i][col - 1 + j] = value;
          });
        });
      },
      setFontWeight: () => {},
    }),
    appendRow: (values: unknown[]) => {
      rows.push([...values]);
    },
    setFrozenRows: () => {},
  };
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) =>
          key === "LEADERBOARD_SECRET" ? secret : "test-sheet",
      }),
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: () => (sheetExists ? sheet : null),
        insertSheet: () => {
          sheetExists = true;
          return sheet;
        },
      }),
      flush: () => {},
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (busy) return false;
          locked = true;
          return true;
        },
        hasLock: () => locked,
        releaseLock: () => {
          locked = false;
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text: string) => ({ setMimeType: () => text }),
    },
  };
  const script = readFileSync(
    new URL("../../integrations/google-sheets/Leaderboard.gs", import.meta.url),
    "utf8",
  );
  const api = runInNewContext(
    `${script}\n({setupLeaderboard, doPost})`,
    context,
  ) as {
    setupLeaderboard: () => void;
    doPost: (event: { postData: { contents: string } }) => string;
  };
  api.setupLeaderboard();
  return {
    rows,
    setBusy: (value: boolean) => {
      busy = value;
    },
    call: (body: unknown) =>
      JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } })),
    fetcher: (async (_input, init) =>
      new Response(api.doPost({ postData: { contents: String(init?.body) } }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
  };
}
