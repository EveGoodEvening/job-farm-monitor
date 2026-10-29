// The SqlDriver contract lives in ../types.ts so the pure entry point can
// export it; this module re-exports it under the path named in docs/todo.md.
export type { ExecResult, SqlDriver, SqlExec, SqlValue } from '../types.js';
