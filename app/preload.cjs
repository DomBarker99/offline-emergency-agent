// Bridge between the window and the main process. The window gets exactly two functions, nothing else.
// (Plain CommonJS on purpose: sandboxed preload scripts can't be TypeScript or ES modules.)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  info: () => ipcRenderer.invoke("info"),
  ask: (question, history) => ipcRenderer.invoke("ask", { question, history }),
});
