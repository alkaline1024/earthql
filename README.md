<h1><img src="apps/desktop/src/renderer/public/earthql.png" width="40" height="40" alt=""> EarthQL</h1>

macOS desktop database client for **PostgreSQL, MySQL, Databricks and Microsoft SQL Server**.
Electron + React + TypeScript. Version 0.1 (first release scope).

## Install and update

Download the macOS installer from [GitHub Releases](https://github.com/alkaline1024/earthql/releases) and drag EarthQL to **Applications**. If macOS blocks the first launch, see the [installation steps](RELEASING.md). Supported builds silently check for updates at launch and every 30 minutes; use the **Update** button when one is available, or **Help → Check for Updates…** to check manually. Download progress is shown as a percentage. See the [release guide](RELEASING.md) for preparing and publishing a release.

## Run

```bash
npm install          # also applies patches/ (see "SQL Server DECIMAL" below)
npm run dev          # start the app with hot reload
npm run dist:mac     # build apps/desktop/release/EarthQL-<version>-arm64-mac.dmg (ad-hoc signed)
```

Requires Node 20+ and macOS 12+. `dist:mac:universal` builds Apple Silicon + Intel; it needs the x64 optional
native packages (`@napi-rs/keyring-darwin-x64`, Databricks kernel) installed as well.

In **Settings → Appearance**, choose the Classic or Modern UI style independently of the color theme. Classic is the default; both choices are saved on this Mac.

For SQL Server, leave Database empty to connect to the login's default database, enter a database, or use **…** to search the databases visible to the login. Azure SQL Database lists databases through `master` and connects to each database separately; database visibility and access depend on the login's permissions.

For Databricks, paste an OAuth M2M JDBC URL (`AuthMech=11;Auth_Flow=1`) into **JDBC URL** to fill the connection fields. Review the settings and save; the client secret is stored in Keychain, not in the profile or the URL field. Other JDBC options and authentication flows are not imported.

PostgreSQL, MySQL and SQL Server profiles can connect through an SSH tunnel using a key loaded in the SSH agent (`SSH_AUTH_SOCK`). Enter the SSH host, user, port and independently verified OpenSSH SHA256 host-key fingerprint. EarthQL rejects a fingerprint mismatch and does not store SSH private keys or passwords. MySQL's Verify certificate mode is not supported through a tunnel; Databricks tunneling is not supported.

## Move connections between EarthQL and TablePlus

- **TablePlus → EarthQL:** Export in TablePlus for macOS with a file password. Select **Include database passwords** to transfer them. In EarthQL, open **Connections → Import**, enter the file password, and choose the `.tableplusconnection` file. EarthQL saves included database passwords to Keychain for new or matching profiles that need a password. `Connections.plist` imports profile settings only.
- **EarthQL → TablePlus:** Open **Connections → Export**, choose the selected connection or all supported connections, and set a file password. On the TablePlus welcome screen, choose **Import Connection → From File** and use the same password. Enter each database password in TablePlus after import.
- PostgreSQL, MySQL, and SQL Server profiles transfer. EarthQL imports connections from groups into its flat list, skips duplicate profiles, and skips profiles that require unsupported SSH, socket, or authentication settings. EarthQL SSH-tunneled profiles are skipped on export. Review TLS settings after transfer when using custom certificates or SQL Server.

## Table filters

Filter rows support AND / OR, IN lists and Raw SQL conditions. Changing AND / OR on an applied row updates the results immediately; other edits require Apply or Apply All. For example, `id IN (1, 2) OR id = 3` matches IDs 1, 2 and 3, while AND matches none.

**Add row** and **Duplicate** append green pending rows directly to the grid. Edit them in place, then **Save** to insert them; **Discard** or deleting a pending row removes it without writing to the database. Identity/generated columns use DEFAULT; duplicated primary keys are reset so manual keys can be entered. DEFAULT and NULL remain distinct from empty text.

With the grid focused, **Copy Rows** (⌘C) followed by **Paste Rows** (⌘V) stages new rows rather than overwriting existing rows. Full-width external TSV can also be pasted as rows; **Paste Cells** and **Paste into selected cells** (⌘⇧V) retain cell-editing behavior. Text editors keep native paste. Copied rows within EarthQL preserve NULL, embedded tabs/newlines and exact numeric strings; copied columns must match the target table. Pending rows participate in unsaved-change protection. On transactional tables, Save applies existing edits and new inserts in one transaction. A failed save retains drafts; an unknown commit outcome blocks retry until Discard and refresh.

Click **SQL** at the left of the filter footer to inspect the executed SQL and bound values for the last submitted filters, sort and page. After a filter error, it shows a rebuilt preview of that request instead. Unapplied edits are excluded. Restart the desktop dev app after changing main-process SQL generation; renderer hot reload alone does not update it.

## Bookmarked tables and views

Right-click a table or view and choose **Add to Bookmarks**, or drag one or more selected tables or views from the object tree directly into Bookmarks or a bookmark folder. Opening a bookmark also expands the object tree and selects the original table or view. Bookmarks and the section's open or closed state are saved per connection profile. Use **New Folder** or the Bookmarks context menu to create folders, rename or delete folders, and move bookmarks between folders. Select multiple bookmarks with ⌘-click or ⇧-click to move them together. Drag entries to reorder them or into a folder, and drop a bookmark on the Bookmarks heading to move it back to the top level. Drag the divider above Bookmarks to resize the section. Deleting a folder keeps its bookmarks. Bookmarks can be removed from the section or the context menu. Right-click an object or container and choose **Copy full path** to copy its dot-separated path; multiple selected tables or views are copied one per line.

## Search and saved queries

Use **Search all…** in the sidebar to search accessible tables and views across databases and schemas, or search their column names. Column searches read metadata for each object and may take time; inaccessible locations are listed separately. A separately scoped connection searches only its scope.

In table data, **Save filters…** saves the currently applied filters and sort for that table and connection profile on this Mac. Saved filter values are stored locally. Select a saved filter to load or delete it.

Query history can be filtered by SQL text, status, date, and open connection. Saved queries can act as snippets: write placeholders such as `{{customer_id}}`, then choose **Fill variables…**. Values are substituted as SQL text, not bound parameters; quote and escape them and review the SQL before running it.

**Explain** shows an estimated plan for the selected or current read-only query on PostgreSQL, MySQL, Databricks, and SQL Server. It does not use `ANALYZE` or execute the query. SQL Server uses an isolated connection and requires SHOWPLAN permission. Connection details show the last-known status and offer a test using a separate connection; this test does not replace the current session.

Connection actions also offer **Schema Compare** and **ER Diagram**. Choose a database and schema to compare object, column, index, and constraint metadata, or view foreign-key relationships. Inaccessible or unsupported metadata is reported as incomplete; comparisons do not generate migrations or compare view definitions and triggers.

## Production confirmation

Connections whose environment label contains `prod` require confirmation before table writes, imports, table actions, and SQL execution. All SQL is confirmed, including queries that appear read-only, because database functions can have side effects. Cancellation sends no operation to the database. This is a warning, not a substitute for database permissions.

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

- Secrets (password, client secret, access token) are stored only in the macOS Keychain (service `EarthQL`, account `<profileId>:<field>`) and are never sent back to the UI. Listing or editing profiles does not read them; connecting, testing a connection, or listing databases reads only the needed secret. The form cannot confirm whether an existing secret is saved until a connection is attempted. Error messages pass through `redact()`.
- EarthQL uses free ad-hoc signing; after an app update macOS may ask for the login Keychain password again when a saved credential is used, even if Always Allow was previously selected.
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

Unit tests include a shared four-driver SQL/error contract, mocked discovery for each driver, and Databricks session
and authentication tests. Integration tests exercise PostgreSQL, MySQL and SQL Server against real databases:
connection and errors, discovery, structure, inserts, filters, paging, grid saves, precision, cancellation and
autocomplete. Set `EARTHQL_IT_SETUP_RO=1` to also test read-only privileges.

Databricks integration tests require a real SQL warehouse and an identity allowed to create and drop a disposable
table in a dedicated test schema. Set `EARTHQL_IT_DATABRICKS_HOST`, `EARTHQL_IT_DATABRICKS_HTTP_PATH`,
`EARTHQL_IT_DATABRICKS_CATALOG`, `EARTHQL_IT_DATABRICKS_SCHEMA` and `EARTHQL_IT_DATABRICKS_TOKEN` in your
environment (do not commit credentials), then run `npm run test:integration`. The suite covers connection,
authentication, discovery, structure, insertion, filters, SQL errors, autocomplete and unsupported grid edits.
Unset drivers are skipped; a partially configured Databricks workspace fails the configuration check.
Set `EARTHQL_IT_REQUIRE_ALL=1` to make the run fail unless all four drivers are configured. Skipped tests do not
constitute real-database coverage.

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
- The SQL Query shows *waiting for warehouse* / *queued* / *running* from the operation state.

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
- VPN requirements.
