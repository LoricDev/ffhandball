# Intégration facturation ↔ API (clés API)

Guide pour connecter **ton site de paiement** (séparé) à l'API ffhandball, afin de distribuer et
renouveler des clés API aux abonnés (€1/mois).

> **Périmètre.** L'API ne gère **pas** le paiement. Elle expose seulement la gestion des clés via
> `/admin/api-keys` (garde `X-Admin-Secret`). Ton site gère Stripe et appelle ces endpoints. Le code
> ci-dessous est un **exemple de référence** à adapter dans ton site (autre dépôt).

## Vue d'ensemble

```
Abonné ──paie──▶ Stripe ──webhook──▶ TON SITE ──HTTP (X-Admin-Secret)──▶ API ffhandball
                                          │
                                          └─ stocke le mapping subscription_id ↔ key_prefix
```

| Événement | Action côté site | Appel API |
|---|---|---|
| 1er abonnement (paiement validé) | créer la clé, **montrer le token UNE fois** à l'abonné | `POST /admin/api-keys` |
| Paiement mensuel récurrent | prolonger d'1 mois | `POST /admin/api-keys/:key_prefix/renew` |
| Résiliation / impayé | révoquer (ou laisser expirer) | `POST /admin/api-keys/:key_prefix/revoke` |

**Modèle de validité.** Chaque clé porte `valid_until`. L'API refuse (401) au-delà. Donc même sans
révocation explicite, une clé non renouvelée **expire d'elle-même** à la fin du mois payé.

## Règles de sécurité

- `ADMIN_SECRET` vit **uniquement côté serveur** de ton site (jamais dans le navigateur/JS client).
  Génère-le avec `openssl rand -hex 32`.
- Le **token** (`ffhb_…`) n'est renvoyé qu'**une seule fois** par `POST /admin/api-keys`. L'API n'en
  stocke que le hash sha256 — impossible de le ré-afficher. Montre-le à l'abonné immédiatement
  (page de succès) et/ou envoie-le par email, puis ne le conserve pas en clair.
- Stocke seulement le **`key_prefix`** (ex. `ffhb_1a2b3c4d`) pour mapper l'abonnement ↔ la clé
  (renew/revoke). Le `key_prefix` n'est pas secret.
- Vérifie la **signature des webhooks Stripe** (`stripe.webhooks.constructEvent`).

## Recommandation de flux

Crée la clé dans le **handler de retour de Checkout** (synchrone, tu peux montrer le token tout de
suite), et utilise les **webhooks** pour les renouvellements et résiliations.

### 1. Création à l'abonnement (handler de succès Checkout)

```ts
// Côté TON site (Node/TS). Pseudo-exemple.
const API = "https://api.ton-domaine.fr";
const ADMIN_SECRET = process.env.ADMIN_SECRET!; // serveur uniquement

async function onCheckoutSuccess(sessionId: string) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  if (session.payment_status !== "paid") throw new Error("non payé");

  // Crée une clé valable 1 mois
  const res = await fetch(`${API}/admin/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
    body: JSON.stringify({ label: session.customer_details?.email, months: 1 }),
  });
  const { data } = await res.json(); // { token, key_prefix, valid_until, ... }

  // Mappe l'abonnement Stripe ↔ la clé (pour renew/revoke ultérieurs)
  await stripe.subscriptions.update(session.subscription as string, {
    metadata: { ffhb_key_prefix: data.key_prefix },
  });

  // Montre data.token À L'ABONNÉ MAINTENANT (page de succès / email). Ne le stocke pas en clair.
  return data.token;
}
```

### 2. Renouvellement mensuel (webhook `invoice.paid`)

```ts
// Stripe envoie invoice.paid à chaque paiement réussi (y compris le 1er).
// On ignore la 1re facture (clé déjà créée à l'étape 1) via billing_reason.
async function onInvoicePaid(invoice: Stripe.Invoice) {
  if (invoice.billing_reason === "subscription_create") return; // déjà géré
  const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
  const prefix = sub.metadata.ffhb_key_prefix;
  if (!prefix) return;

  await fetch(`${API}/admin/api-keys/${prefix}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
    body: JSON.stringify({ months: 1 }),
  });
}
```

### 3. Résiliation / impayé (webhook `customer.subscription.deleted`)

```ts
async function onSubscriptionDeleted(sub: Stripe.Subscription) {
  const prefix = sub.metadata.ffhb_key_prefix;
  if (!prefix) return;
  await fetch(`${API}/admin/api-keys/${prefix}/revoke`, {
    method: "POST",
    headers: { "x-admin-secret": ADMIN_SECRET },
  });
}
```

> Alternative plus simple : ne pas révoquer du tout. Comme `valid_until` n'est avancé qu'au paiement,
> une résiliation arrête simplement les futurs `renew`, et la clé expire à la fin du mois déjà payé.

## Référence des endpoints admin

Tous exigent `X-Admin-Secret: $ADMIN_SECRET`. Sans `ADMIN_SECRET` configuré côté API → `503`.

| Méthode | Chemin | Body | Réponse |
|---|---|---|---|
| `POST` | `/admin/api-keys` | `{ label?, months?=1, rate_limit_per_min?, noExpiry? }` | `201 { data: { token, key_prefix, label, valid_until, rate_limit_per_min } }` |
| `GET` | `/admin/api-keys` | — | `{ data: [ { key_prefix, label, active, valid_until, rate_limit_per_min, last_used_at } ] }` |
| `POST` | `/admin/api-keys/:key_prefix/renew` | `{ months?=1 }` | `{ data: { key_prefix, valid_until } }` (404 si inconnue) |
| `POST` | `/admin/api-keys/:key_prefix/revoke` | — | `{ data: { key_prefix, active:false } }` (404 si inconnue) |

`noExpiry: true` crée une clé sans expiration (à réserver à un usage interne/gratuit, pas pour les
abonnés payants).

## Côté abonné : utiliser la clé

```bash
curl https://api.ton-domaine.fr/clubs?q=brest \
  -H "Authorization: Bearer ffhb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

La doc interactive (`/docs`, Swagger) propose un bouton **Authorize** pour coller le token.

## Gestion manuelle (sans site) — CLI

Pour bootstrapper ou dépanner directement sur le serveur :

```bash
npm run apikey -- create --label=client@example.com --months=1   # token affiché UNE fois
npm run apikey -- list
npm run apikey -- renew  --prefix=ffhb_xxxxxxxx --months=1
npm run apikey -- revoke --prefix=ffhb_xxxxxxxx
```

## Activer l'auth en production

```env
API_AUTH_ENABLED=true
ADMIN_SECRET=<openssl rand -hex 32>
API_KEY_DEFAULT_RATE_LIMIT_PER_MIN=120
```

Tant que `API_AUTH_ENABLED=false`, l'API reste en accès libre (les clés ne sont pas exigées).
