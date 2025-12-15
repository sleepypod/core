/**
 * This file contains the root router of your tRPC-backend
 */
import { publicProcedure, router } from '../trpc';
import { z } from 'zod';

export const appRouter = router({
  healthcheck: publicProcedure.query(() => 'yay!'),

  greeting: publicProcedure
    .input(
      z.object({
        name: z.string(),
      }),
    )
    .query(({ input }) => {
      return `Hello ${input.name}!`;
    }),
});

export type AppRouter = typeof appRouter;
