#!/usr/bin/env node
/**
 * Serveur MCP Judilibre
 * Connecte Claude à l'API Judilibre de la Cour de cassation
 * Via le protocole Model Context Protocol (MCP) over HTTP/SSE
 */

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ─── Configuration ────────────────────────────────────────────────────────────
const JUDILIBRE_BASE = "https://api.piste.gouv.fr/cassation/judilibre/v1.0";
const CLIENT_ID = process.env.PISTE_CLIENT_ID;
const CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;

// ─── Authentification PISTE OAuth2 ────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30000) {
    return tokenCache.token;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "openid",
  });

  const res = await fetch(
    "https://identity.piste.gouv.fr/api/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erreur authentification PISTE: ${err}`);
  }

  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}

// ─── Appel API Judilibre ──────────────────────────────────────────────────────
async function callJudilibre(endpoint, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${JUDILIBRE_BASE}${endpoint}`);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erreur API Judilibre (${res.status}): ${err}`);
  }

  return res.json();
}

// ─── Définition des outils MCP ────────────────────────────────────────────────
const TOOLS = [
  {
    name: "judilibre_rechercher",
    description:
      "Recherche des décisions de justice dans la base Judilibre de la Cour de cassation. Permet une recherche en plein texte et/ou par critères (chambre, formation, solution, date, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Texte libre à rechercher dans les décisions (mots-clés, expression juridique, etc.)",
        },
        operator: {
          type: "string",
          enum: ["or", "and", "exact"],
          description:
            "Opérateur de recherche : 'or' (au moins un mot), 'and' (tous les mots), 'exact' (expression exacte). Par défaut : 'or'.",
        },
        chamber: {
          type: "string",
          description:
            "Filtre par chambre : 'Chambre civile 1', 'Chambre civile 2', 'Chambre civile 3', 'Chambre commerciale', 'Chambre criminelle', 'Chambre sociale', 'Chambre mixte', 'Assemblée plénière'",
        },
        formation: {
          type: "string",
          description:
            "Filtre par formation : 'Formation de section', 'Formation restreinte', 'Plénière de chambre', etc.",
        },
        solution: {
          type: "string",
          description:
            "Filtre par solution : 'Cassation', 'Rejet', 'Irrecevabilité', 'Désistement', 'Non-lieu', 'Avis', etc.",
        },
        date_start: {
          type: "string",
          description: "Date de début au format YYYY-MM-DD (ex: 2020-01-01)",
        },
        date_end: {
          type: "string",
          description: "Date de fin au format YYYY-MM-DD (ex: 2024-12-31)",
        },
        publication: {
          type: "string",
          description:
            "Filtre par publication : 'b' (Bulletin), 'r' (Rapport annuel), 'l' (Lettre de chambre), 'c' (Communiqué)",
        },
        field: {
          type: "string",
          description:
            "Zone de recherche : 'all' (tout), 'expose' (exposé du litige), 'moyens' (moyens), 'motivations' (motivations), 'dispositif', 'summary' (sommaire), 'number' (numéro de pourvoi)",
        },
        page_size: {
          type: "number",
          description: "Nombre de résultats par page (max 50, défaut 10)",
        },
        page: {
          type: "number",
          description: "Numéro de page (commence à 0)",
        },
        sort: {
          type: "string",
          enum: ["score", "date_asc", "date_desc"],
          description:
            "Tri : 'score' (pertinence), 'date_asc' (plus ancienne), 'date_desc' (plus récente)",
        },
      },
    },
  },
  {
    name: "judilibre_decision",
    description:
      "Récupère le texte intégral et toutes les métadonnées d'une décision de justice à partir de son identifiant Judilibre.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Identifiant unique de la décision dans Judilibre (obtenu via judilibre_rechercher)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "judilibre_taxonomie",
    description:
      "Liste les valeurs possibles pour les filtres de recherche Judilibre (chambres, formations, solutions, publications, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        attribut: {
          type: "string",
          enum: [
            "chamber",
            "formation",
            "solution",
            "publication",
            "jurisdiction",
            "theme",
            "location",
          ],
          description: "Attribut pour lequel lister les valeurs possibles",
        },
      },
    },
  },
  {
    name: "judilibre_statistiques",
    description:
      "Retourne des statistiques sur la base Judilibre : nombre de décisions indexées, répartition par année, etc.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ─── Exécution des outils ─────────────────────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {
    case "judilibre_rechercher": {
      const params = {
        query: args.query,
        operator: args.operator,
        chamber: args.chamber,
        formation: args.formation,
        solution: args.solution,
        date_start: args.date_start,
        date_end: args.date_end,
        publication: args.publication,
        field: args.field,
        page_size: args.page_size ?? 10,
        page: args.page ?? 0,
        sort: args.sort ?? "score",
      };

      const data = await callJudilibre("/search", params);

      if (!data.results || data.results.length === 0) {
        return {
          type: "text",
          text: "Aucune décision trouvée pour ces critères de recherche.",
        };
      }

      const lines = [
        `**${data.total} décision(s) trouvée(s)** (page ${(args.page ?? 0) + 1})\n`,
      ];

      for (const r of data.results) {
        lines.push(`---`);
        lines.push(`**${r.chamber || "Chambre inconnue"}** — ${r.formation || ""}`);
        lines.push(
          `📅 ${r.decision_date || "Date inconnue"} | 🔖 Pourvoi n° ${r.number || "N/A"}`
        );
        lines.push(`⚖️ Solution : ${r.solution || "Non précisée"}`);
        if (r.publication && r.publication.length > 0)
          lines.push(`📚 Publication : ${r.publication.join(", ")}`);
        if (r.summary && r.summary.length > 0)
          lines.push(`\n*Sommaire :* ${r.summary[0]}`);
        lines.push(`🆔 ID : \`${r.id}\``);
      }

      if (data.next_page !== undefined) {
        lines.push(
          `\n*(Pour la page suivante, relancez avec page=${data.next_page})*`
        );
      }

      return { type: "text", text: lines.join("\n") };
    }

    case "judilibre_decision": {
      const data = await callJudilibre("/decision", { id: args.id });

      const lines = [
        `# ${data.chamber || "Décision"} — ${data.decision_date || ""}`,
        `**Numéro de pourvoi :** ${data.number || "N/A"}`,
        `**Formation :** ${data.formation || "N/A"}`,
        `**Solution :** ${data.solution || "N/A"}`,
        `**Publication :** ${(data.publication || []).join(", ") || "Non publiée"}`,
        "",
      ];

      if (data.summary && data.summary.length > 0) {
        lines.push("## Sommaire");
        lines.push(data.summary.join("\n\n"));
        lines.push("");
      }

      if (data.text) {
        lines.push("## Texte intégral");
        lines.push(data.text);
      }

      return { type: "text", text: lines.join("\n") };
    }

    case "judilibre_taxonomie": {
      const params = args.attribut ? { attribut: args.attribut } : {};
      const data = await callJudilibre("/taxonomy", params);

      const lines = [`**Valeurs disponibles${args.attribut ? ` pour "${args.attribut}"` : ""} :**\n`];
      for (const item of data) {
        lines.push(`- **${item.id}** : ${item.label || item.id}`);
      }

      return { type: "text", text: lines.join("\n") };
    }

    case "judilibre_statistiques": {
      const data = await callJudilibre("/stats");
      const lines = [`**Statistiques Judilibre**\n`];

      if (data.index) {
        lines.push(`📊 Décisions indexées : **${data.index.total?.toLocaleString("fr-FR") || "N/A"}**`);
      }
      if (data.date) {
        lines.push(`📅 Décision la plus ancienne : ${data.date.min || "N/A"}`);
        lines.push(`📅 Décision la plus récente : ${data.date.max || "N/A"}`);
      }

      return { type: "text", text: lines.join("\n") };
    }

    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

// ─── Endpoint MCP (SSE) ───────────────────────────────────────────────────────
app.get("/mcp", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Envoyer les infos du serveur
  const serverInfo = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "judilibre-mcp", version: "1.0.0" },
    },
  };

  res.write(`data: ${JSON.stringify(serverInfo)}\n\n`);

  req.on("close", () => res.end());
});

// ─── Endpoint MCP (POST JSON-RPC) ────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  try {
    let result;

    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "judilibre-mcp", version: "1.0.0" },
      };
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const toolResult = await executeTool(params.name, params.arguments || {});
      result = { content: [toolResult] };
    } else if (method === "notifications/initialized") {
      return res.status(200).json({ jsonrpc: "2.0", id });
    } else {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Méthode inconnue: ${method}` },
      });
    }

    res.json({ jsonrpc: "2.0", id, result });
  } catch (err) {
    console.error("Erreur:", err.message);
    res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message },
    });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    name: "Serveur MCP Judilibre",
    version: "1.0.0",
    status: "ok",
    endpoint: "/mcp",
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "❌ Variables d'environnement manquantes : PISTE_CLIENT_ID et PISTE_CLIENT_SECRET"
  );
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`✅ Serveur MCP Judilibre démarré sur le port ${PORT}`);
  console.log(`   Endpoint MCP : http://localhost:${PORT}/mcp`);
});
