[README.md](https://github.com/user-attachments/files/25859301/README.md)
# Serveur MCP Judilibre

Connecte Claude (claude.ai) à l'API **Judilibre** de la Cour de cassation via le protocole MCP.

## Outils disponibles pour Claude

| Outil | Description |
|-------|-------------|
| `judilibre_rechercher` | Recherche plein texte et par critères (chambre, formation, solution, date…) |
| `judilibre_decision` | Récupère le texte intégral d'une décision par son ID |
| `judilibre_taxonomie` | Liste les valeurs possibles pour les filtres (chambres, solutions…) |
| `judilibre_statistiques` | Statistiques générales de la base Judilibre |

---

## Déploiement sur Render.com (recommandé pour claude.ai)

### Prérequis
- Clés API PISTE (Client ID + Client Secret) pour l'API Judilibre
- Compte GitHub : https://github.com
- Compte Render.com : https://render.com

---

### Étape 1 — Publier le code sur GitHub

1. Connectez-vous sur **https://github.com**
2. Cliquez sur **"New repository"** (bouton vert en haut à droite)
3. Nommez-le `judilibre-mcp`, cochez **"Public"**, puis **"Create repository"**
4. Sur la page du dépôt créé, cliquez sur **"uploading an existing file"**
5. Glissez-déposez les deux fichiers : `server.js` et `package.json`
6. Cliquez sur **"Commit changes"**

---

### Étape 2 — Déployer sur Render.com

1. Connectez-vous sur **https://render.com**
2. Cliquez sur **"New +"** puis **"Web Service"**
3. Choisissez **"Build and deploy from a Git repository"**
4. Connectez votre compte GitHub si ce n'est pas fait, puis sélectionnez `judilibre-mcp`
5. Remplissez le formulaire :
   - **Name** : `judilibre-mcp`
   - **Runtime** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : `Free`
6. Descendez jusqu'à **"Environment Variables"** et ajoutez :
   - `PISTE_CLIENT_ID` → votre Client ID PISTE
   - `PISTE_CLIENT_SECRET` → votre Client Secret PISTE
7. Cliquez sur **"Create Web Service"**

⏳ Le déploiement prend 2-3 minutes. Une fois terminé, Render vous donne une URL du type :
```
https://judilibre-mcp.onrender.com
```

---

### Étape 3 — Connecter à Claude.ai

1. Ouvrez **https://claude.ai** dans votre navigateur
2. Cliquez sur votre **avatar** (en haut à droite) → **"Paramètres"**
3. Dans le menu de gauche, cliquez sur **"Connecteurs"** (ou *Integrations*)
4. Cliquez sur **"Ajouter un connecteur personnalisé"**
5. Dans le champ URL, saisissez :
   ```
   https://judilibre-mcp.onrender.com/mcp
   ```
6. Donnez un nom : `Judilibre - Cour de cassation`
7. Validez et enregistrez

---

### Étape 4 — Tester

Ouvrez une nouvelle conversation dans Claude et demandez par exemple :

> *"Recherche dans Judilibre des arrêts récents de la Chambre commerciale sur la responsabilité du dirigeant"*

> *"Trouve des décisions de la Cour de cassation sur le préjudice d'anxiété"*

---

## Note sur le plan gratuit Render

Sur le plan gratuit, le serveur se met en veille après 15 minutes d'inactivité.
La première requête après une période d'inactivité peut prendre ~30 secondes (réveil du serveur).
Pour un usage régulier, cela est généralement transparent.

---

## Variables d'environnement requises

| Variable | Description |
|----------|-------------|
| `PISTE_CLIENT_ID` | Client ID de votre application PISTE |
| `PISTE_CLIENT_SECRET` | Client Secret de votre application PISTE |
| `PORT` | Port d'écoute (défini automatiquement par Render) |
