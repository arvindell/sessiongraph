import { handle } from '../server/handler';
export default { fetch: (request: Request) => handle(request) };
