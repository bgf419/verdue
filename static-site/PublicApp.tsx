import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import ClaimApp, { type AccountBackend, type User } from "../app/ClaimApp";
import {
  createSupabaseDataStore,
  type SupabaseClientLike,
} from "../app/supabase-data";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const configuredPersistenceMode = import.meta.env.VITE_PERSISTENCE_MODE?.trim().toLowerCase();
const isSharedGithubOrigin =
  typeof window !== "undefined" && window.location.hostname.toLowerCase() === "bgf419.github.io";
const requestedPersistenceMode =
  configuredPersistenceMode === "disabled" ||
  configuredPersistenceMode === "local" ||
  configuredPersistenceMode === "supabase"
    ? configuredPersistenceMode
    : "disabled";
const persistenceMode =
  isSharedGithubOrigin && requestedPersistenceMode === "local"
    ? "disabled"
    : requestedPersistenceMode;
const supabase =
  persistenceMode === "supabase" && supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;

const ACCOUNT_EMAIL_DOMAIN = "accounts.verdue.invalid";

function accountEmailFor(value: string) {
  const accountId = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]|\.(?=[a-z0-9_-])){1,30}[a-z0-9_-]$/.test(accountId)) {
    throw new Error(
      "Account ID must be 3–32 characters using lowercase letters, numbers, dots, hyphens, or underscores; dots cannot repeat or appear at either end.",
    );
  }
  return `${accountId}@${ACCOUNT_EMAIL_DOMAIN}`;
}

function publicUser(session: Session | null): User {
  if (!session?.user) return null;
  const authEmail = session.user.email ?? "";
  const suffix = `@${ACCOUNT_EMAIL_DOMAIN}`;
  const accountId = authEmail.endsWith(suffix) ? authEmail.slice(0, -suffix.length) : "";
  return {
    displayName: accountId || "Member",
    accountId,
  };
}

export default function PublicApp() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const authenticatedUserId = session?.user.id ?? null;
  const dataStore = useMemo(() => {
    if (!supabase || !authenticatedUserId) return null;
    return createSupabaseDataStore(
      supabase as unknown as SupabaseClientLike,
      authenticatedUserId,
    );
  }, [authenticatedUserId]);

  const accountBackend = useMemo<AccountBackend | undefined>(() => {
    if (!supabase) return undefined;
    return {
      async signUp({ accountId, password }) {
        const { error } = await supabase.auth.signUp({
          email: accountEmailFor(accountId),
          password,
        });
        if (error) throw error;
      },
      async signIn({ accountId, password }) {
        const { error } = await supabase.auth.signInWithPassword({
          email: accountEmailFor(accountId),
          password,
        });
        if (error) throw error;
      },
      async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      },
      async deleteAccount() {
        if (!dataStore) throw new Error("Sign in before deleting this account.");
        await dataStore.deleteAccount();
        await supabase.auth.signOut({ scope: "local" });
      },
    };
  }, [dataStore]);

  if (persistenceMode === "disabled" || (persistenceMode === "supabase" && !supabase)) {
    return <ClaimApp user={null} storageMode="disabled" />;
  }

  if (persistenceMode === "local") {
    return <ClaimApp user={null} storageMode="local" />;
  }

  return (
    <ClaimApp
      key={authenticatedUserId ?? "signed-out"}
      user={publicUser(session)}
      storageMode="supabase"
      accountBackend={accountBackend}
      dataStore={dataStore}
    />
  );
}
