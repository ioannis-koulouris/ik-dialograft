import { z } from 'zod';
import { inputs } from '../tools/schemas.js';
import { tools, toolNames } from '../tools/registry.js';

export function toolInputJsonSchema(name: keyof typeof inputs) {
  return z.toJSONSchema(inputs[name], { io: 'input', unrepresentable: 'any' });
}

/** OpenAPI document generated from the same Zod schemas the API validates with. */
export function buildOpenApi() {
  const paths: Record<string, unknown> = {};
  for (const name of toolNames) {
    paths[`/v1/tools/${name}`] = {
      post: {
        operationId: name,
        summary: tools[name].description,
        'x-permission': tools[name].permission,
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: toolInputJsonSchema(name) } } },
        responses: {
          200: { description: 'Result with pending notifications', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolResponse' } } } },
          400: { description: 'Invalid input' }, 401: { description: 'Missing or invalid token' },
          403: { description: 'Missing permission' }, 404: { description: 'Not found' }, 409: { description: 'Conflict' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Dialograft API', version: '0.1.0', description: 'Demo invoicing API. Demo data only, no accounting documents.' },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ToolResponse: {
          type: 'object',
          properties: { result: {}, replayed: { type: 'boolean' }, pendingNotifications: { type: 'array', items: { type: 'object' } } },
          required: ['result', 'replayed', 'pendingNotifications'],
        },
      },
    },
    paths,
  };
}
