# Webhooks de résultats

Un abonné reçoit un `POST` JSON signé chaque fois qu'un match passe à **joué** ou **forfait**, ou que son score change. Plus besoin d'interroger l'API en boucle.

## Fonctionnement

1. Un trigger PostgreSQL sur `core.matchs` détecte un résultat nouveau ou modifié (statut `joue` / `forfait`, scores, équipe forfait).
2. Il écrit un événement (`core.match_events`) et une livraison par abonné **actif** concerné (`core.webhook_deliveries`).
3. Le cron `webhooks-deliver.sh` (chaque minute) envoie les livraisons dues, avec reprises.

Un nouvel abonné ne reçoit **pas** l'historique : seulement les résultats postérieurs à son abonnement.

## Gérer les abonnements (admin)

Toutes les routes demandent l'en-tête `X-Admin-Secret`.

```bash
# Créer (le secret n'est affiché QU'À la création)
curl -X POST https://api.handapi.fr/admin/webhooks \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"url":"https://exemple.fr/hooks/handball","label":"Site du club","club_id_ffhb":"1720"}'

# Lister (avec compteurs en attente / livrés / abandonnés)
curl https://api.handapi.fr/admin/webhooks -H "X-Admin-Secret: $ADMIN_SECRET"

# Envoyer un événement de test (livré en moins d'une minute)
curl -X POST https://api.handapi.fr/admin/webhooks/1/test -H "X-Admin-Secret: $ADMIN_SECRET"

# Historique des livraisons, désactiver / réactiver, supprimer
curl https://api.handapi.fr/admin/webhooks/1/deliveries -H "X-Admin-Secret: $ADMIN_SECRET"
curl -X POST   https://api.handapi.fr/admin/webhooks/1/disable -H "X-Admin-Secret: $ADMIN_SECRET"
curl -X POST   https://api.handapi.fr/admin/webhooks/1/enable  -H "X-Admin-Secret: $ADMIN_SECRET"
curl -X DELETE https://api.handapi.fr/admin/webhooks/1         -H "X-Admin-Secret: $ADMIN_SECRET"
```

- `club_id_ffhb` (optionnel) : n'envoyer que les matchs dont une équipe porte ce club (`equipes.ext_structure_id`). Les ententes ne sont pas couvertes. Sans ce champ, **tous** les matchs sont envoyés.
- L'URL doit être en **HTTPS** et pointer vers un hôte **public** (refus de `localhost`, des IP privées, des métadonnées cloud, des noms résolvant vers une IP privée).

## Requête reçue

```
POST /hooks/handball
content-type: application/json
x-webhook-id: <uuid unique par envoi>
x-webhook-delivery: <id de livraison, stable entre les reprises>
x-webhook-timestamp: 1760450000
x-webhook-signature: sha256=<hex>
```

```json
{
  "id": 4812,
  "type": "match.result",
  "created_at": "2026-10-14T20:31:02.114Z",
  "data": {
    "id_ffhb_match": "2705640",
    "date_heure": "2026-10-14T18:30:00.000Z",
    "statut": "joue",
    "forfait_equipe": null,
    "journee": 5,
    "score_dom": 31,
    "score_ext": 27,
    "score_mt_dom": 15,
    "score_mt_ext": 13,
    "equipe_dom": { "id_ffhb": "2118783", "nom": "HBC EXEMPLE" },
    "equipe_ext": { "id_ffhb": "2118784", "nom": "ASSM EXEMPLE" },
    "poule_id_ffhb": "195093",
    "competition_nom": "1ERE DIVISION TERRITORIALE FEMININE",
    "saison": "2026-2027"
  }
}
```

Un forfait a `statut: "forfait"` et `forfait_equipe: "dom" | "ext"` (l'équipe qui a fait forfait). Le type `ping` sert aux tests : `data` contient un simple message.

## Vérifier la signature

`signature = HMAC_SHA256(secret, timestamp + "." + corps_brut)`, en hexadécimal, préfixée par `sha256=`. Calculez-la sur le **corps brut** reçu (avant tout `JSON.parse`) et rejetez les horodatages de plus de 5 minutes (anti-rejeu).

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, rawBody, headers) {
  const ts = Number(headers["x-webhook-timestamp"]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const given = String(headers["x-webhook-signature"] ?? "");
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

## Réponse attendue et reprises

- Répondez **2xx** en moins de 10 s. Traitez ensuite en tâche de fond.
- Toute autre réponse (ou un délai dépassé) déclenche une reprise : après 1 min, 5 min, 30 min, 2 h, 6 h, 24 h. Au bout de 7 tentatives la livraison est abandonnée (`failed`).
- Une même livraison peut arriver **plus d'une fois** : dédupliquez avec `x-webhook-delivery` ou avec `id`.
- Les redirections ne sont pas suivies.
- Après 30 échecs consécutifs, l'abonnement est **désactivé** automatiquement (réactivable avec `/enable`).

## Maintenance

`pnpm maintenance` purge les événements et livraisons de plus de 30 jours.
