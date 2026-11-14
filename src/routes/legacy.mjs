export function registerLegacy(router) {
  router.get('/CMD_API_PING', () => ({ json: { error: 0, text: 'ok' } }));
}
