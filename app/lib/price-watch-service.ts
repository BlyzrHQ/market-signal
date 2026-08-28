import { openBillingDatabase } from "./billing-store.ts";
import {
  activatePriceWatchers,
  deletePriceWatcher,
  listPriceWatchers,
  mutatePriceWatcher,
  priceWatchHistory,
  type PriceWatchActivationInput,
  type PriceWatchMutation,
} from "./price-watch-store.ts";

export type PriceWatchActor = {
  workspaceId: string;
  userId: string;
};

export type PriceWatchServiceDependencies = {
  openDatabase: typeof openBillingDatabase;
  now: () => Date;
};

export function priceWatchServiceDependencies(): PriceWatchServiceDependencies {
  return {
    openDatabase: openBillingDatabase,
    now: () => new Date(),
  };
}

async function withDatabase<T>(
  services: PriceWatchServiceDependencies,
  operation: (database: Awaited<ReturnType<typeof openBillingDatabase>>) => T | Promise<T>,
): Promise<T> {
  const database = await services.openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

export async function listWorkspacePriceWatchers(
  workspaceId: string,
  services: PriceWatchServiceDependencies = priceWatchServiceDependencies(),
) {
  return withDatabase(services, (database) => listPriceWatchers(database, workspaceId, services.now()));
}

export async function activateWorkspacePriceWatchers(
  actor: PriceWatchActor,
  input: PriceWatchActivationInput,
  services: PriceWatchServiceDependencies = priceWatchServiceDependencies(),
) {
  return withDatabase(services, (database) => activatePriceWatchers(database, actor.workspaceId, actor.userId, input, services.now()));
}

export async function getWorkspacePriceWatchHistory(
  workspaceId: string,
  watcherId: string,
  limit = 100,
  services: PriceWatchServiceDependencies = priceWatchServiceDependencies(),
) {
  return withDatabase(services, (database) => priceWatchHistory(database, workspaceId, watcherId, limit));
}

export async function updateWorkspacePriceWatcher(
  actor: PriceWatchActor,
  watcherId: string,
  input: PriceWatchMutation,
  services: PriceWatchServiceDependencies = priceWatchServiceDependencies(),
) {
  return withDatabase(services, (database) => mutatePriceWatcher(database, actor.workspaceId, actor.userId, watcherId, input, services.now()));
}

export async function disableWorkspacePriceWatcher(
  actor: PriceWatchActor,
  watcherId: string,
  services: PriceWatchServiceDependencies = priceWatchServiceDependencies(),
) {
  return updateWorkspacePriceWatcher(actor, watcherId, { action: "disable" }, services);
}

export async function deleteWorkspacePriceWatcher(
  actor: PriceWatchActor,
  watcherId: string,
  services: PriceWatchServiceDependencies = priceWatchServiceDependencies(),
) {
  return withDatabase(services, (database) => deletePriceWatcher(database, actor.workspaceId, actor.userId, watcherId, services.now()));
}
