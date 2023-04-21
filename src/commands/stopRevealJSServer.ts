export const STOP_REVEALJS_SERVER = 'vscode-revealmajs.stopRevealJSServer'
export type STOP_REVEALJS_SERVER = typeof STOP_REVEALJS_SERVER

export const stopRevealJSServer = (stopServer: () => void) => () => {
  stopServer()
}
