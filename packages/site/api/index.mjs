import { handle } from '../dist-api/handler.mjs';

export default { fetch: (request) => handle(request) };
