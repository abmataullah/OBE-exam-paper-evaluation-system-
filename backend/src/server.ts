import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { router as assessmentsRouter } from './routes/assessments';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', assessmentsRouter);

// Optionally serve the built frontend (desktop app sets FRONTEND_DIST).
const frontendDist = process.env.FRONTEND_DIST;
if (frontendDist && fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback: any non-API route serves index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) =>
    res.json({ name: 'OBE Evaluation API', status: 'running' })
  );
}

// 404 (only reached for non-static, non-API paths when no frontend dist)
if (!frontendDist) {
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[obe-api] listening on http://localhost:${PORT}`);
});

export default app;
