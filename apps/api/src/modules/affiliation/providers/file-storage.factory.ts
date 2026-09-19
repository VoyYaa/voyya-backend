import { EnvService } from '../../../config/env.service';
import type { FileStorageProvider } from '../ports/file-storage.port';
import { LocalFileStorageProvider } from './local-file-storage.provider';
import { SupabaseStorageProvider } from './supabase-storage.provider';

export function createFileStorageProvider(env: EnvService): FileStorageProvider {
  const url = env.get('SUPABASE_URL');
  const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (url && serviceRoleKey) {
    return new SupabaseStorageProvider({
      url,
      serviceRoleKey,
      bucket: env.get('SUPABASE_STORAGE_BUCKET'),
    });
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error(
      'STORAGE: missing Supabase credentials (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) ' +
        'and the local stub is forbidden in production. Configure them to enable document uploads.',
    );
  }

  return new LocalFileStorageProvider();
}
