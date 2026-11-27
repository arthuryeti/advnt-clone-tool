import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod/v4";
import { redactSecrets } from "@/lib/security/redact";

/** No auth: single tenant, every procedure works on WORKSPACE_ID. Add a session check here to gate it. */
const t = initTRPC.create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    message: redactSecrets(shape.message),
    data: {
      ...shape.data,
      stack: undefined,
      zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
    },
  }),
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;
