# @puppi/adapter-google-sheets

Source connector for the Google Sheets API. It reads a range and writes records into a sheet. Auth is a bearer access token. Writes need one of `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/drive`, or `https://www.googleapis.com/auth/drive.file`.

The API version is the `v4` prefix of the base URL. `base_url` defaults to `https://sheets.googleapis.com`. A binding that omits `api_version` uses `v4`. `spreadsheet_id` is the spreadsheet this client reads and writes.

`values(range)` is `GET /v4/spreadsheets/{spreadsheetId}/values/{range}`. `rows(range)` turns that body into objects. The first row is the header. A repeated header is `name`, then `name_2`. A missing cell is null. Empty rows at the end are dropped.

`appendRows(range, rows)` and `updateRows(range, rows)` use that same header. A record key that is not a header throws, and no write is sent. A null or missing cell is sent as `""`. Sheets skips a null and would leave the previous value. `clearValues(range)` does not read the header. `valueInputOption` is `RAW` on both writes: cells are stored as text. `USER_ENTERED` would parse dates and formulas, and `rows()` would read different strings back.

`appendRows` reads the header, then `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=RAW`. Sheets appends after the last table in `range`, starting at that table's first column. Pass one table whose first row is the header. A range that also contains a later table appends onto the later table while the columns still come from the first row. The call does not send `insertDataOption`. Sheets then overwrites data after the table. A second call appends the same records again. A lost response can duplicate them.

`updateRows` reads the header, then `POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate` with `valueInputOption` `RAW` and one range: the row after the header, with no end cell. A shorter list blanks the leftover data rows from that read with `""`. A longer list extends the sheet. The header row is not written. The same records written again leave the same cells. The read and the write are two requests, so another writer can change the sheet in between.

`clearValues` is `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:clear` with `{}`. Values are cleared. Formatting stays. A header inside `range` is cleared. Clearing a range that is already empty leaves it empty.

Ranges are A1 notation, the same strings `rows()` takes. A column-only ref such as `Sheet1!A:C` treats row 1 as the header. A sheet name with no cell uses the range Sheets returns from the read.

Quotas, from the [Sheets usage limits](https://developers.google.com/workspace/sheets/api/limits): 300 read requests and 300 write requests per minute per project, and 60 of each per minute per user per project. A request past the quota is `429`. `appendRows` and `updateRows` spend one read and one write. `clearValues` spends one write. One batch counts as one request. Google recommends a 2 MB payload. A request that runs longer than 180 seconds times out. A spreadsheet holds up to 20 million cells or 100 MB ([Drive file limits](https://support.google.com/drive/answer/37603)).

`check()` calls `GET /v4/spreadsheets/{spreadsheetId}?fields=spreadsheetId`.

```json
{
  "google-sheets": {
    "config": { "spreadsheet_id": "spreadsheet id" },
    "secret_refs": { "access_token": "sheets_access_token" }
  }
}
```

Reference: <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values>
