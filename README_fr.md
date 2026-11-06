![Aperçu social](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[简体中文](https://github.com/bowenliang123/dsh-context/blob/main/README.md) · [English](https://github.com/bowenliang123/dsh-context/blob/main/README_en.md) · [日本語](https://github.com/bowenliang123/dsh-context/blob/main/README_ja.md) · [Español](https://github.com/bowenliang123/dsh-context/blob/main/README_es.md) · [Français](https://github.com/bowenliang123/dsh-context/blob/main/README_fr.md) · [Deutsch](https://github.com/bowenliang123/dsh-context/blob/main/README_de.md) · [Русский](https://github.com/bowenliang123/dsh-context/blob/main/README_ru.md) · [Português](https://github.com/bowenliang123/dsh-context/blob/main/README_pt.md)

[![Version npm](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![Étoiles GitHub](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**Le meilleur [plugin DeepSeek Harness](https://www.deepseek.com/harness/) pour analyser et gérer le contexte de l’agent.**

> Recommandé et étoilé par les membres de l’équipe DeepSeek Harness [@tianyicui](https://github.com/tianyicui) et [@turtle1999](https://github.com/turtle1999) — voir [cette publication sur X](https://x.com/tianyi/status/2105256532657267119).

[`dsh-context`](https://www.npmjs.com/package/dsh-context) offre des fonctionnalités complètes de gestion du cycle de vie du contexte.
- **Page Analyse du contexte** — la vue d’ensemble intersessions sous forme de panneau de premier niveau dans la barre latérale, aux côtés de Plugins et des tâches d’automatisation : bande d’indicateurs clés avec graphique d’utilisation des tokens et des coûts sur 7 jours, carte thermique d’activité, anneau de composition agrégée et cartes de session filtrables permettant d’accéder directement à chaque session.
- **Onglet Contexte** — un tableau de bord graphique des statistiques, de la composition, de la tendance, des événements, des messages et des commandes du contexte de DeepSeek Harness.
- **Onglet Flotte** — la page dédiée à la famille d’agents : l’agent actuel, ses parents et tous ses sous-agents, chacun avec sa propre carte en direct.
- **Panneau Contexte** — le même tableau de bord sous forme d’onglet dans la barre latérale droite : sélectionnez **Contexte** dans la page de guide de la barre latérale pour ouvrir le panneau à côté du chat, avec le réseau d’agents inclus.
- **Commande `/context`** — la commande slash affiche le modèle de contexte pour examiner la composition actuelle du contexte et son évolution récente.

▶️ **Présentation vidéo de 4 minutes** — [regarder sur Bilibili](https://www.bilibili.com/video/BV1bn4K6TEEV/) (en chinois).

[![dsh-context et DeepSeek Harness : composition du contexte, évolution et équipes multi-agents](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/video-cover.jpg)](https://www.bilibili.com/video/BV1bn4K6TEEV/)

## Installation / Mise à jour

### Installer sur DeepSeek Harness web ou de bureau

Saisissez `dsh-context` dans le champ de recherche de l’assistant **Ajouter un plugin**, puis cliquez sur **Installer** :

![Assistant Ajouter un plugin](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/add-plugin-wizard.png)

### Installer avec la CLI `dsh`

Installez le plugin [`dsh-context`](https://www.npmjs.com/package/dsh-context) depuis [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) :

```sh
dsh plugin --profile web add dsh-context
```

Ou mettez à jour le plugin `dsh-context` :

```sh
dsh plugin --profile web update dsh-context@latest
```

Démarrez ensuite l’interface web avec `dsh web`. Aucune compilation ni aucun redémarrage nécessaire.

## Utilisation

Cinq interfaces, un même récit : ce que votre agent emporte avec lui, comment il en est arrivé là et ce qu’il en a fait :

| Emplacement | Ce que vous obtenez |
| --- | --- |
| **Page Analyse du contexte** | Toutes les sessions en un coup d’œil : utilisation, coût, succès du cache, activité quotidienne et profils de contexte par session, filtrés par plage, jour, groupe ou recherche, avec accès en un clic. |
| **Onglet Contexte** | Le tableau de bord complet : statistiques, composition, tendance par requête, événements, activité des fichiers et exécutions de commandes, dans chaque session. |
| **Onglet Flotte** | Le réseau d’agents : l’agent actuel, ses parents et tous ses sous-agents, en direct. |
| **Commande `/context`** | Une fenêtre modale centrée avec la même composition et le même navigateur de contexte, sans quitter le chat. |
| **Carte Préférences** | Les valeurs par défaut de chaque utilisateur : entrée du panneau, plage d’Analyse du contexte, tendance et tris par défaut, ainsi que préfixe et suffixe de l’invite système ajoutés autour de chaque session. |

## 🗂️ La page Analyse du contexte

Cliquez sur **Analyse du contexte** dans la liste des panneaux de la barre latérale, au même niveau que **Plugins** et **Tâches d’automatisation** ; la page s’ouvre en pleine largeur dans la colonne centrale :

![La page Analyse du contexte](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| Section | La question à laquelle elle répond |
| --- | --- |
| **Bande d’indicateurs clés** | Quelle est mon utilisation ? Sessions actives dans la plage choisie (7 j / 30 j / tout), avec tokens facturés, coût estimé, taux de succès du cache et tours répartis selon le jour de début de chaque étape ; les exécutions d’outils et le temps actif couvrent toute la durée de vie de ces sessions et de leurs sous-agents, en cohérence avec la carte des durées. |
| **Graphique d’utilisation sur 7 jours** | Quand ai-je dépensé quoi ? Les tokens facturés et le coût estimé de chacun des 7 derniers jours forment une paire de barres, regroupés selon le jour de début de chaque requête dans sa session, et non selon le dernier jour d’activité de la session. |
| **Carte thermique d’activité** | Quand est-ce que je travaille réellement ? Les tokens facturés quotidiennement au cours des 8 dernières semaines ; cliquez sur un jour pour filtrer les sessions et limiter les trois cartes de totaux à ce jour. |
| **Chargements de compétences** | Quelles compétences ai-je chargées, à quelle fréquence et à quand remonte leur dernier chargement ? Les chargements de la plage par compétence ; cliquez sur l’une pour filtrer les sessions qui l’ont chargée. |
| **Appels d’outils** | Quels outils ont été exécutés, à quelle fréquence et à quand remonte leur dernière exécution ? Les exécutions de la plage par outil, issues du registre quotidien ; cliquez sur l’un pour filtrer les sessions qui l’ont exécuté. |
| **Exécutions de commandes** | Quels programmes ont été exécutés, à quelle fréquence et à quand remonte leur dernière exécution ? Les exécutions de commandes de la plage par programme, comptabilisées au moment de leur envoi ; cliquez sur l’un pour filtrer les sessions qui l’ont exécuté. |
| **Entrée des paramètres** | La puce dans l’en-tête de la page : le même accès contrôlé aux préférences de ce plugin que celui de la carte Informations sur le plugin de l’onglet Contexte. |
| **Composition du contexte** | Où sont allés les tokens facturés de la plage choisie, répartis selon les catégories facturées de la carte Tokens : appels d’outils, raisonnement, réponses, etc. |
| **Cartes de session** | Le profil de chaque session sous les quatre cartes : anneau de composition, tokens facturés, tours, coût et fil d’Ariane du groupe d’espaces de travail ou du projet ; triées par date, tokens ou taille du contexte, avec recherche et regroupement par espace de travail. Un clic sur une carte ouvre la session. |


## 📊 L’onglet Contexte

Ouvrez une session et cliquez sur l’onglet **Contexte** :

![Vue d’ensemble du panneau Contexte](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| Carte | La question à laquelle elle répond |
| --- | --- |
| **Statistiques du contexte** | Tours, étapes, saisies humaines et appels d’outils en direct, ainsi qu’un coût estimé à partir des tarifs publics de models.dev ; survolez le `?` pour voir les tarifs par million de tokens. Seul DeepSeek distingue les heures pleines et creuses : ses tarifs affichés correspondent aux heures creuses et les périodes de pointe sont facturées à 2×. |
| **Statistiques des tokens** | Où sont allés les tokens facturés : le même total que la ligne de statistiques du chat sous l’éditeur, réparti entre invite système, schémas d’outils, messages utilisateur, contexte injecté, injections de compétences, appels d’outils, raisonnement et réponses. Les appels d’outils regroupent leurs noms et arguments, rejoués dans l’invite et générés dans la sortie, ainsi que les résultats renvoyés par ces outils ; les réponses isolent le texte des réponses du modèle dans le même contenu de l’assistant et la même sortie ; le raisonnement isole de la même façon sa réflexion ; le taux de succès du cache de la session figure dans le coin. |
| **Statistiques de durée** | Comment le temps actif se répartit entre les appels au modèle, les exécutions d’outils et la surcharge. |
| **Contexte actuel** | Ce que contient la fenêtre *en ce moment même*. |
| **Tendance du contexte** | La taille de chaque requête et son histoire. |
| **Navigateur de contexte** | À partir de quoi chaque requête a été *réellement* assemblée. |
| **Événements de contexte** | Quand et pourquoi la fenêtre a changé. |
| **Activité des fichiers** | Ce que l’agent a *fait* à vos fichiers. |
| **Exécutions de commandes** | Ce que l’agent a exécuté, comment chaque exécution s’est terminée et sur quels programmes il s’est appuyé. |

L’estimation des coûts suit un ensemble de règles documenté : [Comment les tarifs des modèles sont associés](docs/model-pricing-mapping.md).

L’occupation et la composition principales lisent les **mêmes projections officielles du compteur de tokens que l’anneau de contexte de l’éditeur de chat** (`contextPressure` / `contextBreakdown`), de sorte que les chiffres correspondent toujours à ceux de l’anneau ; le pourcentage de la carte représente cette même occupation, affichée avec une décimale.

La cellule Réseau d’agents de la carte **Statistiques du contexte**, qui indique les tokens facturés et le coût estimé de toute la famille, ouvre l’onglet **Flotte**. Ses pastilles Entrées / Sorties sont également des liens : **Saisies humaines** ouvre le **navigateur de contexte** sur vos messages, tandis que **Lus / Écrits / Recherchés / Images** ouvre la carte **Activité des fichiers** avec le type correspondant sélectionné.

### Statistiques du contexte

#### Statistiques des tokens et Statistiques de durée
![Statistiques des tokens et Statistiques de durée](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Statistiques du contexte
![Statistiques du contexte](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)


### 🧱 Contexte actuel — contenu actuel de la fenêtre de contexte

![Carte Contexte actuel](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

Une barre empilée à six couleurs comparée à la fenêtre complète du modèle, les deux masques hachurés à la fin représentant la réserve de compaction automatique : sa marge, puis la fenêtre de sortie réservée à la requête. Elle présente l’invite système, les schémas d’outils, les messages utilisateur, le contexte injecté, les réponses de l’assistant et les résultats d’outils, chacun avec son nombre approximatif de tokens et sa part. Lorsqu’une conversation commence à se dégrader, c’est ici que vous voyez *quelle partie* en est responsable.

### 📈 Tendance du contexte — croissance et évolution du contexte par tour ou par étape

![Tendance du contexte avec le résumé d’étape](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

Une barre empilée par requête au modèle, plus précise qu’une barre par message, pour observer la croissance de la fenêtre tour après tour :

- **✨ Résumé d’étape** — trois lignes en langage clair sous le graphique : **Utilisateur** rappelle le message qui a ouvert le tour, **Entrée** énumère ce qui vient d’entrer, généralement les résultats des outils précédents, et **Réponse** montre la réponse et/ou les outils appelés. Cliquez sur une ligne pour ouvrir ce message précis dans le navigateur de contexte.
- **✂ signale les événements** — les compactions et les élagages sont rattachés à la barre où ils ont eu lieu, afin que les baisses s’expliquent d’elles-mêmes.
- **Lisez-le à votre façon** — granularité **Étape / Tour**, **Total** pour la composition cumulée ou **Delta** pour la variation signée de chaque requête, avec défilement horizontal sur toute la session. En mode Delta, la croissance s’accumule au-dessus de la ligne de base et une compaction plonge en dessous :

![Tendance du contexte en mode Delta](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **Vue d’ensemble** — un bouton compresse toute la session, étapes ou tours, dans la largeur du panneau sous forme de ruban empilé continu : chaque baisse due à une compaction et chaque changement de composition en un coup d’œil, sans défilement horizontal ni chargement supplémentaire. Des repères indiquent les quartiles et toute la plage ; survolez pour parcourir, survolez une bande pour mettre cette catégorie en évidence sur tout le ruban ; cliquez pour fixer l’étape et ouvrir la catégorie de cette bande dans le navigateur. Cette vue est mutuellement exclusive avec les modes DNA et Adaptatif.
- **Survol et fixation** — parcourez pour obtenir une infobulle instantanée ; cliquez pour fixer la répartition complète, avec les valeurs réelles **Invite / Sortie / Cache** signalées par le fournisseur à côté des estimations.
- **Liaison en direct** — survoler une barre prévisualise le contexte assemblé de cette étape dans le navigateur de contexte à côté du graphique ; quitter le graphique rétablit votre propre sélection.

### 🧭 Navigateur de contexte — ouvrez la boîte de n’importe quelle requête

Choisissez **En direct (prochaine requête)** ou toute étape conservée, puis parcourez les éléments à partir desquels cette requête a été assemblée : sept catégories réductibles se développent en une ligne par élément avec son coût en tokens, et chaque élément se développe à son tour pour révéler son **contenu réel** : invite système, schéma JSON de chaque outil, texte des messages, raisonnement, arguments des outils et sorties des outils. Le contenu des compétences, catalogue des compétences disponibles, invocations `/skill` et chargements de l’outil `skill`, possède sa propre catégorie **Injections de compétences**, afin que l’empreinte contextuelle d’une compétence discrète ne puisse pas se cacher dans les catégories du contexte injecté et des résultats d’outils.

- **Qui fournit chaque outil** — chaque ligne de schéma d’outil comporte une puce de source établie au mieux : packages propriétaires `tool-*`, packages de fonctionnalités `dsh-*`, proxys `mcp:<server>` ou plugin exact suivi en direct depuis `tools.register()`. Triez par **taille / nom** et filtrez chaque catégorie selon ses propres champs de recherche :

![Schémas d’outils avec puces de source, filtre et tri](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **Filtrez les réponses de l’assistant par type** — le champ de recherche de la catégorie de l’assistant comporte les puces **Raisonnement / Outils / Réponse**, chacune comptant les réponses de ce type dans les résultats de recherche actuels, sachant qu’une réponse peut en comporter plusieurs ; cliquez sur l’une pour ne conserver que les réponses correspondantes, puis de nouveau pour effacer le filtre :

![Réponses de l’assistant avec puces de filtre par type](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-assistant-kinds.png)

- **Les résultats d’outils ouvrent l’appel complet** — le nom et les arguments de l’outil avec son statut **OK/erreur**, le corps du résultat avec le nombre de lignes et un bouton **Brut / Markdown** :

![Résultat d’outil développé avec sélecteur Brut/Markdown](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **Les pièces jointes s’affichent sous forme de cartes ordonnées** — les blocs `image` et `file` d’un message sont réunis dans l’ordre où le message les transporte, avec une carte chacun : les images ont une miniature, leurs dimensions, leur taille stockée et l’estimation officielle de DeepSeek en tokens ; les autres fichiers ont leur glyphe de type, leur extension et leur taille stockée. Un clic ouvre la pièce jointe dans la colonne d’aperçu de dsh, avec visionneuses Markdown, code, PDF, bureautique et image, sous le nom réel du fichier :

![Cartes de pièces jointes image avec dimensions, taille stockée et estimation en tokens](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **Comparaison avec le tour précédent** — des badges de delta signés par catégorie, `+N` éléments et `±Nk` tokens, indiquent d’un coup d’œil ce qu’un tour a ajouté ou récupéré. Les étapes antérieures à une compaction sont reconstruites à partir de l’archive des messages supprimés, et la carte l’indique lorsque la composition d’une étape n’est qu’approximative.

- **Le mode DNA déploie tout le contexte à plat** — la barre dessine une bande par élément dans l’ordre de lecture du modèle et, en dessous, ces mêmes éléments forment une liste plate avec le message le plus récent en haut ; le modèle lisant du plus ancien au plus récent, la liste présente cet ordre de bas en haut. Chaque ligne indique sa position dans l’invite (`#12`), sa catégorie, l’étape qui l’a introduite et son coût en tokens, puis se développe pour afficher le même contenu complet ; les schémas d’outils et l’invite système ferment la liste sous forme de deux lignes de groupe. La carte s’aligne exactement sur les cartes de composition et de tendance adjacentes : une session entièrement aplatie défile à l’intérieur au lieu d’envahir la page.

### ⚡ Événements de contexte — quand et pourquoi la fenêtre a changé

![Événements de contexte avec une compaction](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

Chaque injection, compaction, élagage, changement de modèle et activation ou désactivation du mode Plan est étiqueté avec son producteur, fichier d’instructions, identifiant de plugin ou nom de compétence, son delta net de tokens, les compactions indiquant ce qu’elles ont récupéré, son tour ou son étape et son heure. Les puces **Injection / Compaction / Élagage / Changement / Mode** filtrent le journal par type et indiquent chacune le nombre total d’événements de la session.

### 📁 Activité des fichiers — ce que l’agent a fait à vos fichiers

![Activité des fichiers](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

Une ligne par fichier touché, lu, écrit ou recherché, agrégée jusqu’à l’étape choisie sur le graphique de tendance :

- **Compteurs par objectif** avec des puces d’en-tête servant aussi de filtres (**Lus / Écrits / Recherchés / Images**) et un champ de recherche par chemin.
- **Deltas de lignes** — chaque appel `edit`/`write` apporte son empreinte estimée `+ajoutées / −supprimées`, par fichier et au total.
- **Tous les modes comptent** — les outils natifs, `str_replace_editor` du préréglage Minimal et les appels imbriqués dans les programmes PTC `run_code` sont tous regroupés dans les lignes par outil.
- **Les recherches aboutissent à de vrais fichiers** — les fichiers correspondants obtiennent leurs propres lignes d’opérations avec le nombre d’occurrences.
- **Cliquez sur une ligne** pour développer son journal complet des opérations ; chaque opération ouvre directement le résultat exact de l’outil dans le navigateur de contexte.
- **Cliquez sur un nom de fichier** pour ouvrir son aperçu dans la barre latérale droite, exactement comme le fait la barre latérale Fichiers intégrée : même visionneuse et même comportement d’un onglet par fichier. Sur un harness sans cette colonne, le nom ouvre le fichier sur votre système comme auparavant.

### 🖥️ Exécutions de commandes — ce que l’agent a exécuté

![Exécutions de commandes](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/command-executions.png)

Chaque exécution shell ou de code avec son statut, sa durée réelle et son repère d’étape, ainsi qu’un résumé de session, des raccourcis vers les points à examiner et un classement des programmes. Les faits à examiner et le classement portent sur toute la session tandis que les puces de recherche et de statut restreignent la liste. Chaque clic sur le rail inscrit son angle de vue dans le champ de recherche : cliquer sur un programme renseigne et met en évidence ce programme, et cliquer de nouveau efface les deux, de sorte que le champ indique toujours ce qui filtre la liste.

## 🚢 L’onglet Flotte

Ouvrez n’importe quelle session et cliquez sur l’onglet **Flotte** (à droite de **Contexte**) — la famille d’agents sur une page dédiée : une bande de résumé, les cartes **Réseau d’agents** et **Collaboration entre agents**, puis **Tâches d’équipe** et **Inspection des événements**.

![La page Flotte d’une équipe de six agents : résumé de la flotte, réseau d’agents, collaboration entre agents, tâches d’équipe et inspection des événements](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-overview.png)

La bande de résumé compte les agents, les agents en cours, les éléments de travail et les messages. Choisir un agent dans le graphe ou dans une voie restreint la vue de collaboration à cet agent : la page répond pour un membre à la fois.

### 🕸 Réseau d’agents — le portrait de famille

L’agent actuel, ses parents et chaque sous-agent — une carte par agent : son titre, la taille du contexte en direct et l’occupation de la fenêtre, une barre de composition, et depuis combien de temps il tourne et combien d’étapes il a faites. Les arêtes partent de chaque parent dans la couleur du lignage — survolez une carte pour éclairer toute sa chaîne et lire la répartition complète dans la bande de détails ; cliquez sur un nœud pour le mettre en évidence. Les agents en cours respirent avec une pulsation verte sur leur arête entrante et font tourner le propre indicateur rotatif du harness à côté de leur titre, qui se stabilise sur le même point vert que la liste de sous-agents de l’en-tête une fois le travail terminé ; les panneaux étroits replient la famille en lignes ordonnées — jamais de barre de défilement horizontale.

### 🛰 Collaboration entre agents — la famille sur une seule chronologie

Chaque agent reçoit une voie sur une même chronologie : messages entre agents, repères de tâches d’équipe et enregistrements de délégation, les voies calmes se repliant derrière un bouton. Les numéros de tâche identifient une tâche d’une voie à l’autre — des numéros répétés désignent la même tâche — et le survol relie les enregistrements qui vont ensemble. **Earliest / Latest** inverse l’ordre, le champ de recherche resserre les voies, et un clic sur une tâche filtre la chronologie et la révèle.

### ✅ Tâches d’équipe — qui fait quoi

Le tableau **Tâches d’équipe** réunit les tâches d’équipe et les délégations aux sous-agents — groupes par propriétaire, filtres de statut (Toutes / En cours / En attente / Terminées) et liens de blocage qui allument toute la chaîne de prérequis quand vous ciblez une tâche. Chaque carte porte son propriétaire, son brief, ses portées d’écriture et sa réponse finale ; cliquez sur une tâche pour ouvrir sa description complète sur place, brute ou rendue.

### 📡 Inspection des événements — qui a dit quoi à qui

La carte **Inspection des événements** lit automatiquement les journaux de session de la famille — aucune étape d’analyse. Messages, rapports et enregistrements de délégation se filtrent en un seul flux : sélectionnez un nœud de la chronologie ou un enregistrement du flux pour voir l’enregistrement complet — le journal de session d’origine et sa séquence, un avis lorsque le runtime a écrit le règlement plutôt que l’enfant, le rapport de clôture complet (avec son résultat structuré ou son diagnostic), et des cartes de participants qui ouvrent le chat de cet agent dans la barre latérale ou la vue complète. Filtrez par type ou texte, et la sélection d’agent partagée resserre tout le hub.

Le panneau **Contexte** de la barre latérale droite conserve la même carte en ligne, pour que la famille reste à un clic pendant la lecture du chat. Vous ne voulez pas de l’onglet ? Désactivez **Onglet Flotte** dans la carte de préférences — la carte continue de vivre dans ce panneau, et la cellule famille de l’onglet Contexte l’y ouvre dès qu’une barre latérale est disponible.

## ⌨️ Commande `/context`

Saisissez `/context`, ou choisissez-la dans le menu `/`, puis appuyez sur Entrée :

![Menu slash avec la commande context](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

Une boîte de dialogue centrée s’ouvre avec la carte **Composition actuelle** et le **navigateur de contexte** : même barre de composition, sélecteur par étape et badges de comparaison `par rapport au tour précédent` que dans l’onglet :

![La fenêtre modale /context](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ Paramètres

La carte de préférences **Contexte** contient les paramètres de ce plugin propres à chaque utilisateur : **entrée du panneau Contexte**, onglet de conversation **Contexte**, panneau de la barre latérale droite, les deux ou Masquer pour aucun, le lien de la ligne de réponse suivant ce choix ; interrupteur Afficher/Masquer propre à l’onglet **Flotte**, que l’entrée du panneau ne bloque jamais ; plage par défaut d’**Analyse du contexte**, Aujourd’hui / 7 derniers jours / 30 derniers jours / Tout, avec 30 derniers jours par défaut, la sélection d’un préréglage sur la page mettant à jour cette valeur ; granularité de la tendance, Étape/Tour ; mode de la tendance, Total/Delta ; courbe de durée de la tendance, affichée par défaut ; seuil d’étapes pour la vue d’ensemble automatique de la tendance ; base de comparaison du navigateur de contexte ; tri des outils et de l’activité des fichiers ; et interrupteur Afficher/Masquer d’Analyse du contexte. Elle se trouve sur la page **Plugins** : entrée **Plugins** de la barre latérale → page du bundle **dsh-context** → section **Configuration**, la carte étant fournie par le formulaire de configuration actif de l’entrée.

Les lignes **Invite système · Préfixe / Suffixe** contiennent du texte libre ajouté au tout début ou à la toute fin de l’invite système de chaque session, pour tous les agents, sous-agents inclus : une personnalité ou une règle de comportement propre au déploiement, intégrée à l’assemblage d’invite du harness. Les modifications s’appliquent à partir du tour suivant ; laissez une ligne vide pour la désactiver.

Les boutons de préréglage d’Analyse du contexte enregistrent le choix comme valeur par défaut ; tous les autres interrupteurs des graphiques et des cartes restent propres à la vue et n’écrasent jamais la préférence enregistrée.

![La carte des paramètres de Contexte](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## Bon à savoir

- **Empreinte du cache** — le plugin n’enregistre dans le cache de projection de dsh qu’un résumé compact par session : composition, compteurs, coût et durée, informations sur le modèle. Les détails volumineux par événement, textes de surface, répartitions des requêtes, opérations sur les fichiers, programmes de commandes et plages, sont reconstitués à partir du journal durable lorsqu’un panneau en a besoin, afin que le cache reste petit même sur les longues sessions. Les vues détaillées sont bornées : étapes 1500 · tours 300 · événements 400 · nœuds de surface 2000 · archive 400 · opérations sur fichiers 400 · commandes 400.
- **Estimations et valeurs réelles** — les chiffres par catégorie utilisent l’heuristique de densité fixe de dsh, la même que son compteur de tokens intégré ; les détails de tendance fixés affichent à côté les valeurs réelles signalées par le fournisseur, et la carte Tokens associe ses parts de composition estimées avec ≈ au total facturé exact du fournisseur.
- **Compatibilité** — fonctionne avec `@deepseek-ai/dsh` à partir de **0.2.0-rc.2**, les lignes `0.2.0` et `0.2.1` étant vérifiées sur leurs versions rc.2 et la ligne `0.2.2` sur sa version rc.1, avec la génération V4 du journal de session, à partir d’un seul chemin de code guidé par la structure. La matrice par version et sa méthode de vérification : [docs/compatibility.md](docs/compatibility.md).
- **I18n** — interface en 简体中文, English, 日本語, Español, Français, Deutsch, Русский et Português (le changement de langue nécessite dsh 0.2.2+ ; les lignes prises en charge antérieures n’offrent que le chinois et l’anglais).

## Vous aimez ?

Si `dsh-context` vous a aidé à comprendre ce que votre agent emporte avec lui, une ⭐ sur [GitHub](https://github.com/bowenliang123/dsh-context) serait très appréciée ; les tickets et les PR sont également les bienvenus !

## Licence

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
