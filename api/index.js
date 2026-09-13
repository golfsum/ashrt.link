// Vercel serverless entry. The whole Express app runs as one function;
// vercel.json routes every request here.
import app from '../server.js'
import { runStartupMaintenance } from '../lib/startup-maintenance.js'

// Repair derived Redis indexes and quarantine links to built-in blocked
// destinations before this serverless instance starts serving traffic. The
// maintenance routine is lock-protected and rate-limited across instances, so
// most cold starts only perform one cheap metadata read.
await runStartupMaintenance()

export default app
