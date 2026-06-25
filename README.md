# Zotero Citation Visualizer

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=flat-square)](LICENSE)

Build interactive citation graphs from any Zotero collection.

Zotero Citation Visualizer focuses on one job: turning items in a selected collection into an explorable citation network. It includes regular top-level items from the selected collection and all descendant subcollections by default (for example, papers and patents). It can work with local library data only, or enrich the graph with OpenAlex so you can pull in external papers and inspect a broader citation neighborhood.

[English](README.md) | [简体中文](doc/README-zhCN.md)

## Highlights

- Generate a citation graph for the selected collection directly from Zotero.
- Include regular top-level items from descendant subcollections by default.
- Use local citation relations only, or enrich results online with OpenAlex.
- Include external papers and control how deep the graph expands beyond your library.
- Filter subcollections with checkbox chips and color local nodes by subcollection.
- Explore the graph with zoom, pan, reload, node filtering, and click-through actions.

## Quick Look

### Configure the graph

Choose the collection to analyze, enable online enrichment if needed, and set whether external papers should be included. After generation, you can select which subcollections remain visible from the subcollection checkbox list in the graph window.

![Citation Graph options dialog](doc/start_menu.png)

### Collection-focused graph

With external depth set to `0`, the graph stays focused on the collection itself and is easier to scan for local citation structure.

![Citation graph with external depth 0](doc/graph_included_depth0.png)

### Expanded graph with external papers

With online enrichment enabled and external depth set to `1`, the graph can reveal a much larger surrounding citation network.

![Citation graph with external depth 1](doc/graph_included_depth1.png)

## How to Use

1. Select a collection in Zotero.
2. Open the plugin from the collection menu or `Tools > Citation Graph (Selected Collection)`.
3. Set the generation options:
   - `Collection ID`
   - `Use Online Enrichment`
   - `Include External Papers`
   - `External Depth`
4. Click `Generate`.
5. In the graph window, use the `Subcollections` checkboxes (`All` / `None`) to filter descendant subcollections in place.

## Graph Interaction

- Blue nodes are local items visible via the selected root collection scope.
- Colored local nodes map to selected subcollections (color chips in the subcollection list).
- Gray local nodes belong to multiple selected subcollections.
- Orange nodes are external papers; clicking one opens its DOI or OpenAlex page.
- Right-click a node to hide connected edges, hide isolated nodes, or reset hidden elements.
- Use the mouse wheel or pinch to zoom, and drag / two-finger pan to move around the graph.

## Development

- `npm install`
- `npm start` for local development with hot reload
- `npm run build` for a production build plus TypeScript checks

The main implementation lives in `src/modules/citationGraph.ts`.

## Attribution

This project is built on top of `windingwind/zotero-plugin-template`, but the repository is centered on the citation graph feature for Zotero.

The project license is `AGPL-3.0-or-later`.
