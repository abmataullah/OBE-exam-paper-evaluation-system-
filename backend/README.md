# OBE Evaluator — Backend

Express + TypeScript API providing the OBE grading engine. Used unchanged by
both the web deployment (PostgreSQL) and the desktop `.exe` (embedded PGlite).

See the repository root `README.md` for the full product overview.

## Layout

```
src/
  db/
    schema.sql          Full relational schema (enums, tables, trigger, view)
    pool.ts             query()/withTransaction(); picks driver via DB_DRIVER
    pglitePool.ts       Embedded PostgreSQL (WASM) adapter for the desktop app
    runMigration.ts     npm run migrate   (PostgreSQL)
    seed.ts             npm run seed      (demo data, PostgreSQL)
  services/
    excelGenerator.ts   Blank single-sheet template + Excel data validation
    uploadParser.ts     Parse filled template -> create all records, validate
    attainment.ts       CO attainment calculation
    pdfGenerator.ts     Tabulation sheet HTML + Puppeteer PDF
  routes/assessments.ts Express routes
  server.ts             Entry; serves the built frontend when FRONTEND_DIST is set
  test/fillBlank.ts     Helper that fills a blank template (for manual testing)
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `DB_DRIVER` | (pg) | `pglite` = embedded DB (desktop) |
| `PGLITE_DATA_DIR` | — | Required with `DB_DRIVER=pglite` |
| `PG_HOST/PORT/USER/PASSWORD/DATABASE` | localhost/5432/obe_admin/-/obe_system | PostgreSQL |
| `PORT` | 4000 | |
| `FRONTEND_DIST` | — | Serve built SPA from this dir (desktop) |
| `PUPPETEER_EXECUTABLE_PATH` | — | Chrome/Edge path for PDF |
| `ATTAINMENT_THRESHOLD` | 60 | % |

## Run (web mode)

```bash
cp .env.example .env
npm install
npm run build        # tsc + copies schema.sql into dist/
npm run migrate      # fresh database
npm run dev          # http://localhost:4000
```

## Template layout (single "Grading" sheet)

| Rows | Block |
|---|---|
| 3–7 | Department, Program, Course Code/Title, Semester/Exam Date, Assessment/Type/Total Marks |
| 10–20 | Q1..Q10: Max Marks (required to include a question), CO (optional) |
| 23–83 | SL, Student ID, Student Name, Q1..Q10, Total (=SUM formula) |

`uploadParser.ts` reads these fixed positions; keep it in sync with
`LAYOUT` in `excelGenerator.ts`.

## Manual end-to-end test

```bash
curl -o blank.xlsx http://localhost:4000/api/template
node dist/test/fillBlank.js blank.xlsx filled.xlsx            # or --invalid
curl -F file=@filled.xlsx http://localhost:4000/api/process
curl http://localhost:4000/api/courses/1/assessments/1/attainment
curl -o tab.pdf "http://localhost:4000/api/courses/1/assessments/1/tabulation?preparedBy=Dr.%20Khan"
```

## PGlite notes

- `query()` uses prepared statements: **one statement per call**.
  Use `execPglite()` for multi-statement SQL (the schema file).
- `rowCount` mirrors `pg` semantics (rows returned, else affected rows).
- Inside an Electron asar the module is loaded from `app.asar.unpacked` so
  the WASM binary can be read from a real path (`asarUnpack` in desktop config).
