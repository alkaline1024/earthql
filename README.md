<h1><img src="apps/desktop/src/renderer/public/earthql.png" width="40" height="40" alt=""> EarthQL</h1>

macOS desktop database client for **PostgreSQL, MySQL, Databricks and Microsoft SQL Server**.
Electron + React + TypeScript. Version 0.1 (first release scope).

## Install and update

Download the macOS installer from [GitHub Releases](https://github.com/alkaline1024/earthql/releases) and drag EarthQL to **Applications**. If macOS blocks the first launch, see the [installation steps](RELEASING.md). Use **Help → Check for Updates…** to install new team releases. See the [release guide](RELEASING.md) for preparing and publishing a release.

## Run

```bash
npm install          # also applies patches/ (see "SQL Server DECIMAL" below)
npm run dev          # start the app with hot reload
npm run dist:mac     # build apps/desktop/release/EarthQL-<version>-arm64-mac.dmg (ad-hoc signed)
```

Requires Node 20+ and macOS 12+. `dist:mac:universal` builds Apple Silicon + Intel; it needs the x64 optional
native packages (`@napi-rs/keyring-darwin-x64`, Databricks kernel) installed as well.

## Move connections between EarthQL and TablePlus

- **TablePlus → EarthQL:** Export in TablePlus for macOS with a file password. Select **Include database passwords** to transfer them. In EarthQL, open **Connections → Import**, enter the file password, and choose the `.tableplusconnection` file. EarthQL saves included database passwords to Keychain for new or matching profiles that need a password. `Connections.plist` imports profile settings only.
- **EarthQL → TablePlus:** Open **Connections → Export**, choose the selected connection or all supported connections, and set a file password. On the TablePlus welcome screen, choose **Import Connection → From File** and use the same password. Enter each database password in TablePlus after import.
- PostgreSQL, MySQL, and SQL Server profiles transfer. EarthQL imports connections from groups into its flat list, skips duplicate profiles, and skips profiles that require unsupported SSH, socket, or authentication settings. Review TLS settings after transfer when using custom certificates or SQL Server.

## Layout

| Package | Role |
| --- | --- |
| `packages/core` (`@earthql/core`) | Shared types, driver interface, SQL dialect builders (browse / insert / create table), statement splitter, query runner with cancel + row limits, error classification and secret redaction, CSV. No I/O. |
| `packages/driver-postgres` | `pg` + `pg-cursor`. database → schema → table/view. Cancel via `pg_cancel_backend`. |
| `packages/driver-mysql` | `mysql2` streaming with back-pressure. database → table/view. Cancel via `KILL QUERY`. |
| `packages/driver-mssql` | `mssql`/`tedious`, SQL login. database → schema → table/view. Cancel via TDS attention. |
| `packages/driver-databricks` | `@databricks/sql`, OAuth M2M or access token. catalog → schema → table/view (Unity Catalog). |
| `apps/desktop` | Electron app. `src/main`: Keychain, profiles, sessions, IPC (all database clients live here). `src/renderer`: React UI. `src/shared/api.ts`: the IPC contract. |

Design rules the code follows:

- Secrets (password, client secret, access token) are stored only in the macOS Keychain (service `EarthQL`, account `<profileId>:<field>`) and are never sent back to the UI. Error messages pass through `redact()`.
- Every user value is bound as a parameter. Only quoted identifiers and explicitly chosen default *expressions* are written into SQL. Insert / Create statements are rebuilt in the main process from the form spec — the UI never sends write SQL.
- Results keep column order and duplicate names, keep `NULL` distinct from `''`, and keep BIGINT / DECIMAL exact (strings).
- Cancel is two-step: *requested* when the request is sent, *confirmed* only when the database reports the cancellation error.
- A write whose connection drops before a reply is reported as **outcome unknown**, never as failed.
- Insert availability = driver capability → object type (views are blocked) → the account's privilege where the database can answer; otherwise the database enforces it and the error is explained.

## Tests

```bash
npm test                                   # unit tests (SQL builders, splitter, runner, CSV, redaction)
docker compose -f test/docker-compose.yml up -d
EARTHQL_IT_PG="127.0.0.1:55432:postgres:Eq-test-pw1:earthql" \
EARTHQL_IT_MYSQL="127.0.0.1:53306:root:Eq-test-pw1:earthql" \
EARTHQL_IT_MSSQL="127.0.0.1:51433:sa:Eq-test-pw1!:earthql" \
EARTHQL_IT_SETUP_RO=1 npm run test:integration
```

The integration suite runs the same 14 checks per driver: Test Connection, wrong password (auth error, password not
leaked), unreachable host (network error), create table from a spec → structure (types, defaults, PK), insert value /
NULL / DEFAULT / Unicode / 38-digit DECIMAL and read back, filter / sort / paging, duplicate columns + BIGINT,
exact DECIMAL from ad-hoc SQL, row limit + load more, syntax errors, confirmed cancel then run again, autocomplete,
and a read-only account (reads work, writes rejected as *permission*).

**Databricks is not covered by automated tests yet** — it needs a real workspace and SQL warehouse (see open items).

## SQL Server DECIMAL

`tedious` converts DECIMAL/NUMERIC to JavaScript floats, which loses digits beyond ~15. `patches/tedious+20.4.3.patch`
(applied by `patch-package` on `npm install`) makes it return exact decimal strings. If you upgrade `mssql`/`tedious`,
regenerate the patch and re-run the integration tests.

## Databricks connection

- **OAuth M2M**: Server Hostname, HTTP Path, `client_id`, `client_secret` of a service principal. The driver requests
  tokens with the client-credentials grant and requests a new one when it expires. On `*.azuredatabricks.net`
  it uses Databricks OAuth unless an Azure tenant ID is entered (Microsoft Entra service principal).
- **Access token**: a PAT or OAuth bearer token, sent as `Authorization: Bearer`. When it expires, edit the token in
  the same profile and reconnect.
- Test Connection opens a session (waits for a stopped warehouse to start) and runs `SELECT 1`.
- The SQL editor shows *waiting for warehouse* / *queued* / *running* from the operation state.

## Feedback

Open **Help → Send Feedback…** to report a bug or suggest an improvement. You can review, crop, or black out a screenshot before choosing to attach it. See [Feedback setup](feedback/README.md) to set up a Google Sheet and private Drive folder, and to ship a build with the inbox already configured.

## Known limitations (v0.1)

- Databricks rows come back keyed by column name, so duplicate column names in one result show one value (a notice says so).
- MySQL `SLEEP()` / `BENCHMARK()` return normally when killed, so their cancellation shows as "finished before the cancel took effect".
- MySQL insert privileges are read from `information_schema`; with active roles the answer is "unknown" and the server decides.
- SQL Server MONEY in ad-hoc SQL results is a JS number (exact in table browsing).
- Binary values are previewed as the first 64 bytes of hex (also in CSV).
- UI text is English.

## Open items from the plan

- Minimum macOS version (configured as 12.0) and whether Intel builds are required.
- Database versions for acceptance (tested here: PostgreSQL 17, MySQL 8.4, SQL Server 2022).
- Databricks cloud provider, SQL warehouse, and credentials for both auth modes — needed to run the acceptance checks.
- VPN / SSH tunnel requirements (SSH tunnels are not implemented).
