import { useQuery } from '@tanstack/react-query';
import type { OnboardingView } from '@ipro/shared';
import { api } from '../../api.js';

/**
 * The joiner's onboarding, or null when they aren't joining (GET /api/onboarding/me). Its own module
 * so home and the shell can use it without loading the onboarding page (decision #97).
 */
export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: async () =>
      (await api<{ onboarding: OnboardingView | null }>('/onboarding/me')).onboarding,
    enabled,
  });
}
