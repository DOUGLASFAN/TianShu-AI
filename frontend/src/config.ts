// Keep API requests on the page origin; Vite and production Nginx proxy /api.
export const API_BASE_URL='/api';
export const REALTIME_URL=`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${API_BASE_URL}/realtime/ws`;
