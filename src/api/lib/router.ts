// src/api/lib/router.ts — OpenAPIHono avec le format d'erreur de validation commun.
// Sans ce hook, chaque sous-routeur renvoyait le ZodError brut de zod-openapi au lieu de l'enveloppe { error }.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Hook } from "@hono/zod-openapi";

export const validationHook: Hook<unknown, any, any, any> = (result, c) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!result.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST" as const,
          message: "Paramètres invalides",
          details: result.error.flatten(),
        },
      },
      400,
    );
  }
};

export function newRouter(): OpenAPIHono {
  return new OpenAPIHono({ defaultHook: validationHook });
}
