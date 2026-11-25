---
name: local-first-resilience
description: Adds local-first IndexedDB persistence, BroadcastChannel multi-tab sync, Undo/Redo history, JSON import/export, and offline PWA readiness.
---

# Local-First & Resilient UX

- **Durable Storage:** Persist todos in versioned IndexedDB (with safe `localStorage` fallback in restricted contexts) so data survives reloads and upgrades cleanly.
- **Multi-Tab Live Sync:** Broadcast state mutations over `BroadcastChannel` so open browser tabs stay synchronized in real time.
- **Undo / Redo & Safety:** Maintain an undo/redo command stack (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`) paired with an accessible Undo toast for destructive actions (delete, clear completed). Apply CRUD state updates (`setTodos` / storage writes) synchronously on form submit rather than deferring inside `startTransition`.
- **Portability & Offline:** Support JSON export/import with schema validation, React Error Boundaries, and a Web App Manifest + Service Worker respecting dynamic `VITE_BASE_PATH` for GitHub Pages.
