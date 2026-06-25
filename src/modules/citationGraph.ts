const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi;
const MAX_REFERENCES_PER_WORK = 80;
const MAX_EXTERNAL_NODES = 300;
const MAX_QUICK_LOCAL_LOOKUP_ITEMS = 220;
const VIEWBOX_WIDTH = 1800;
const VIEWBOX_HEIGHT = 1200;
const WHEEL_ZOOM_IN_FACTOR = 1.06;
const WHEEL_ZOOM_OUT_FACTOR = 0.94;
const PINCH_SENSITIVITY = 0.0012;
const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const ROOT_LOCAL_NODE_COLOR = "#1976d2";
const MULTI_SUBCOLLECTION_NODE_COLOR = "#64748b";
const EXTERNAL_NODE_COLOR = "#ef6c00";
const NODE_TOOLTIP_DELAY_MS = 80;
const NODE_TOOLTIP_OFFSET_X = 14;
const NODE_TOOLTIP_OFFSET_Y = 14;
const SUBCOLLECTION_PALETTE = [
  "#0077b6",
  "#2a9d8f",
  "#4f772d",
  "#8f5d00",
  "#bc6c25",
  "#d62828",
  "#9d4edd",
  "#6d597a",
  "#5f0f40",
  "#1d3557",
];

interface CitationGraphOptions {
  collectionID: number;
  useOnlineLookup: boolean;
  includeExternalReferences: boolean;
  extensionDepth: number;
}

interface GraphNode {
  id: string;
  nodeType: "local" | "external";
  itemID?: number;
  title: string;
  label: string;
  doi?: string;
  openAlexID?: string;
  depth: number;
  firstAuthor?: string;
  lastAuthor?: string;
  itemDate?: string;
  isInRootCollection?: boolean;
  subcollectionIDs?: number[];
  subcollectionPaths?: string[];
}

interface GraphEdge {
  source: string;
  target: string;
  relation: "local" | "remote";
}

interface CitationGraphData {
  collectionID: number;
  collectionName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  subcollections: SubcollectionInfo[];
  options: CitationGraphOptions;
  truncated: boolean;
}

interface SubcollectionInfo {
  id: number;
  name: string;
  path: string;
  depth: number;
  color: string;
}

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  doi?: string | null;
  referenced_works?: string[];
}

interface OpenAlexWorkListResponse {
  results?: OpenAlexWork[];
}

interface NodePosition {
  x: number;
  y: number;
  r: number;
}

interface CitationCacheData {
  version: number;
  updatedAt: string;
  edgesBySourceKey: Record<string, string[]>;
}

interface GraphViewState {
  hiddenNodeIDs: Set<string>;
  hiddenEdgeKeys: Set<string>;
  selectedSubcollectionIDs: Set<number>;
}

interface LocalItemMembership {
  isInRootCollection: boolean;
  subcollectionIDs: number[];
  subcollectionPaths: string[];
}

interface LocalScopeData {
  items: Zotero.Item[];
  itemMemberships: Map<number, LocalItemMembership>;
  subcollections: SubcollectionInfo[];
}

interface LabColor {
  l: number;
  a: number;
  b: number;
}

interface ColorCandidate {
  css: string;
  lab: LabColor;
}

interface GraphRenderCallbacks {
  onNodeContextMenu?: (
    node: GraphNode,
    event: MouseEvent,
    root: HTMLElement,
  ) => void;
}

class OpenAlexClient {
  private readonly baseURL = "https://api.openalex.org";
  private workCache = new Map<string, OpenAlexWork | null>();
  private refsCache = new Map<string, Map<string, OpenAlexWork>>();

  async resolveWork(node: Pick<GraphNode, "openAlexID" | "doi" | "title">) {
    if (node.openAlexID) {
      const byID = await this.getWorkByOpenAlexID(node.openAlexID);
      if (byID) return byID;
    }

    if (node.doi) {
      const byDOI = await this.getWorkByDOI(node.doi);
      if (byDOI) return byDOI;
    }

    if (node.title) {
      return this.searchWorkByTitle(node.title);
    }

    return null;
  }

  async getReferencedWorks(referenceIDs: string[]) {
    const normalizedIDs = unique(referenceIDs.map(normalizeOpenAlexID));
    if (!normalizedIDs.length) {
      return new Map<string, OpenAlexWork>();
    }

    const cacheKey = normalizedIDs.join("|");
    const cached = this.refsCache.get(cacheKey);
    if (cached) return cached;

    const refsMap = new Map<string, OpenAlexWork>();
    const idChunks = chunk(normalizedIDs, 50);

    for (const idChunk of idChunks) {
      const params = new URLSearchParams({
        filter: `openalex:${idChunk.join("|")}`,
        "per-page": String(Math.min(200, idChunk.length)),
        select: "id,display_name,doi",
      });
      const url = `${this.baseURL}/works?${params.toString()}`;
      const data = await this.requestJSON<OpenAlexWorkListResponse>(url);
      if (!data?.results?.length) continue;

      for (const result of data.results) {
        const openAlexID = normalizeOpenAlexID(result.id);
        if (!openAlexID) continue;
        refsMap.set(openAlexID, result);
      }
    }

    this.refsCache.set(cacheKey, refsMap);
    return refsMap;
  }

  private async getWorkByOpenAlexID(openAlexID: string) {
    const normalizedID = normalizeOpenAlexID(openAlexID);
    if (!normalizedID) return null;

    const cacheKey = `id:${normalizedID}`;
    if (this.workCache.has(cacheKey)) {
      return this.workCache.get(cacheKey) ?? null;
    }

    const url = `${this.baseURL}/works/${normalizedID}?select=id,display_name,doi,referenced_works`;
    const data = await this.requestJSON<OpenAlexWork>(url);
    this.workCache.set(cacheKey, data ?? null);
    return data ?? null;
  }

  private async getWorkByDOI(doi: string) {
    const normalizedDOI = normalizeDOI(doi);
    if (!normalizedDOI) return null;

    const cacheKey = `doi:${normalizedDOI}`;
    if (this.workCache.has(cacheKey)) {
      return this.workCache.get(cacheKey) ?? null;
    }

    const encodedDOI = encodeURIComponent(`https://doi.org/${normalizedDOI}`);
    const url = `${this.baseURL}/works/${encodedDOI}?select=id,display_name,doi,referenced_works`;
    const data = await this.requestJSON<OpenAlexWork>(url);
    this.workCache.set(cacheKey, data ?? null);
    return data ?? null;
  }

  private async searchWorkByTitle(title: string) {
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedTitle) return null;

    const cacheKey = `title:${normalizedTitle}`;
    if (this.workCache.has(cacheKey)) {
      return this.workCache.get(cacheKey) ?? null;
    }

    const params = new URLSearchParams({
      search: title,
      "per-page": "5",
      select: "id,display_name,doi,referenced_works",
    });
    const url = `${this.baseURL}/works?${params.toString()}`;
    const data = await this.requestJSON<OpenAlexWorkListResponse>(url);
    const candidates = data?.results || [];

    if (!candidates.length) {
      this.workCache.set(cacheKey, null);
      return null;
    }

    let bestMatch: OpenAlexWork | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = titleSimilarity(title, candidate.display_name || "");
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    if (bestScore < 0.2) {
      this.workCache.set(cacheKey, null);
      return null;
    }

    this.workCache.set(cacheKey, bestMatch);
    return bestMatch;
  }

  private async requestJSON<T>(url: string) {
    try {
      const xhr = await Zotero.HTTP.request("GET", url, {
        headers: { Accept: "application/json" },
        timeout: 15000,
      });
      return JSON.parse(xhr.responseText || "{}") as T;
    } catch (error) {
      ztoolkit.log("OpenAlex request failed:", url, error);
      return null;
    }
  }
}

export class CitationGraphFactory {
  private static get collectionMenuID() {
    return `${addon.data.config.addonRef}-citation-graph-collection-menu`;
  }

  private static get toolsMenuID() {
    return `${addon.data.config.addonRef}-citation-graph-tools-menu`;
  }

  static registerMenus() {
    const mainWin = Zotero.getMainWindow();
    if (!mainWin?.document) return;

    if (!mainWin.document.getElementById(this.collectionMenuID)) {
      ztoolkit.Menu.register("collection", {
        tag: "menuitem",
        id: this.collectionMenuID,
        label: "Citation Graph",
        isDisabled: () => !this.getSelectedCollectionID(),
        commandListener: () => void this.openGraphFlow(true),
      });
    }

    if (!mainWin.document.getElementById(this.toolsMenuID)) {
      ztoolkit.Menu.register("menuTools", {
        tag: "menuitem",
        id: this.toolsMenuID,
        label: "Citation Graph (Selected Collection)",
        isDisabled: () => !this.getSelectedCollectionID(),
        commandListener: () => void this.openGraphFlow(),
      });
    }
  }

  private static getSelectedCollectionID() {
    return Zotero.getMainWindow()?.ZoteroPane?.getSelectedCollection(true);
  }

  private static getDefaultOptions(collectionID: number): CitationGraphOptions {
    return {
      collectionID,
      useOnlineLookup: true,
      includeExternalReferences: true,
      extensionDepth: 0,
    };
  }

  private static async openGraphFlow(useDefaultOptions = false) {
    const defaultCollectionID = this.getSelectedCollectionID();
    if (!defaultCollectionID) {
      ztoolkit.getGlobal("alert")("No collection selected.");
      return;
    }

    const options = useDefaultOptions
      ? this.getDefaultOptions(defaultCollectionID)
      : await this.promptOptions(defaultCollectionID);
    if (!options) return;

    const progressWindow = new ztoolkit.ProgressWindow("Citation Graph", {
      closeOnClick: true,
      closeTime: -1,
    })
      .createLine({
        text: "Building citation graph...",
        type: "default",
        progress: 5,
      })
      .show();

    try {
      const collection = await Zotero.Collections.getAsync(
        options.collectionID,
      );
      const graphData = await this.buildGraphData(
        collection,
        options,
        (message, progress) => {
          progressWindow.changeLine({ text: message, progress });
        },
      );

      progressWindow.changeLine({
        text: `Done: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`,
        progress: 100,
        type: "success",
      });
      progressWindow.startCloseTimer(2000);
      this.openGraphWindow(graphData);
    } catch (error) {
      ztoolkit.log("Build citation graph failed:", error);
      progressWindow.changeLine({
        text: `Failed: ${String(error)}`,
        progress: 100,
        type: "error",
      });
      progressWindow.startCloseTimer(6000);
    }
  }

  private static async promptOptions(
    defaultCollectionID?: number,
  ): Promise<CitationGraphOptions | null> {
    const dialogData: Record<string, any> = {
      collectionID: defaultCollectionID ? String(defaultCollectionID) : "",
      useOnlineLookup: true,
      includeExternalReferences: true,
      extensionDepth: 0,
    };

    new ztoolkit.Dialog(8, 2)
      .addCell(
        0,
        0,
        {
          tag: "h2",
          namespace: "html",
          properties: { innerText: "Citation Graph Options" },
          styles: { margin: "0" },
        },
        false,
      )
      .addCell(
        1,
        0,
        {
          tag: "p",
          namespace: "html",
          properties: {
            innerText:
              "Use local relations only, or enrich from OpenAlex. External depth only applies to non-library references.",
          },
          styles: {
            width: "420px",
            margin: "0 0 8px 0",
            color: "#555",
            fontSize: "12px",
          },
        },
        false,
      )
      .addCell(2, 0, {
        tag: "label",
        namespace: "html",
        attributes: { for: "citation-graph-collection-id" },
        properties: { innerText: "Collection ID" },
      })
      .addCell(
        2,
        1,
        {
          tag: "input",
          namespace: "html",
          id: "citation-graph-collection-id",
          attributes: {
            type: "number",
            min: "1",
            step: "1",
            "data-bind": "collectionID",
            "data-prop": "value",
          },
          styles: { width: "180px" },
        },
        false,
      )
      .addCell(3, 0, {
        tag: "label",
        namespace: "html",
        attributes: { for: "citation-graph-use-online" },
        properties: { innerText: "Use Online Enrichment" },
      })
      .addCell(
        3,
        1,
        {
          tag: "input",
          namespace: "html",
          id: "citation-graph-use-online",
          attributes: {
            type: "checkbox",
            "data-bind": "useOnlineLookup",
            "data-prop": "checked",
          },
        },
        false,
      )
      .addCell(4, 0, {
        tag: "label",
        namespace: "html",
        attributes: { for: "citation-graph-include-external" },
        properties: { innerText: "Include External Papers" },
      })
      .addCell(
        4,
        1,
        {
          tag: "input",
          namespace: "html",
          id: "citation-graph-include-external",
          attributes: {
            type: "checkbox",
            "data-bind": "includeExternalReferences",
            "data-prop": "checked",
          },
        },
        false,
      )
      .addCell(5, 0, {
        tag: "label",
        namespace: "html",
        attributes: { for: "citation-graph-depth" },
        properties: { innerText: "External Depth" },
      })
      .addCell(
        5,
        1,
        {
          tag: "input",
          namespace: "html",
          id: "citation-graph-depth",
          attributes: {
            type: "number",
            min: "0",
            max: "5",
            step: "1",
            "data-bind": "extensionDepth",
            "data-prop": "value",
          },
          styles: { width: "80px" },
        },
        false,
      )
      .addButton("Generate", "confirm")
      .addButton("Cancel", "cancel")
      .setDialogData(dialogData)
      .open("Build Citation Graph", {
        fitContent: true,
        centerscreen: true,
      });

    await dialogData.unloadLock?.promise;
    if (dialogData._lastButtonId !== "confirm") return null;

    const collectionID = Number.parseInt(String(dialogData.collectionID), 10);
    if (!Number.isFinite(collectionID) || collectionID <= 0) {
      ztoolkit.getGlobal("alert")("Invalid Collection ID.");
      return null;
    }

    return {
      collectionID,
      useOnlineLookup: Boolean(dialogData.useOnlineLookup),
      includeExternalReferences: Boolean(dialogData.includeExternalReferences),
      extensionDepth: clampInt(dialogData.extensionDepth, 0, 5, 0),
    };
  }

  private static async buildGraphData(
    collection: Zotero.Collection,
    options: CitationGraphOptions,
    updateProgress: (message: string, progress: number) => void,
  ): Promise<CitationGraphData> {
    updateProgress("Reading collection and subcollections...", 10);
    const localScope = this.collectLocalScopeData(collection);
    const items = localScope.items;

    if (!items.length) {
      throw new Error(
        "No regular top-level items found in the selected collection scope.",
      );
    }

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const localByItemID = new Map<number, string>();
    const localByItemKey = new Map<string, string>();
    const localItemKeyByNodeID = new Map<string, string>();
    const localByDOI = new Map<string, string>();
    const localByTitle = new Map<string, string>();
    const localByOpenAlexID = new Map<string, string>();

    const cacheData = loadCitationCacheData();
    let cacheUpdated = false;

    updateProgress("Indexing local nodes...", 20);
    for (const item of items) {
      const nodeID = `local:${item.libraryID}:${item.key}`;
      const title = (item.getDisplayTitle() || item.getField("title")).trim();
      const doi = normalizeDOI(item.getField("DOI"));
      const authorDateInfo = extractLocalNodeAuthorAndDate(item);
      const membership = localScope.itemMemberships.get(item.id);
      const node: GraphNode = {
        id: nodeID,
        nodeType: "local",
        itemID: item.id,
        title: title || `Item ${item.id}`,
        label: title || `Item ${item.id}`,
        doi,
        depth: 0,
        firstAuthor: authorDateInfo.firstAuthor,
        lastAuthor: authorDateInfo.lastAuthor,
        itemDate: authorDateInfo.itemDate,
        isInRootCollection: membership?.isInRootCollection ?? false,
        subcollectionIDs: membership?.subcollectionIDs || [],
        subcollectionPaths: membership?.subcollectionPaths || [],
      };

      nodes.set(nodeID, node);
      localByItemID.set(item.id, nodeID);
      localByItemKey.set(item.key, nodeID);
      localItemKeyByNodeID.set(nodeID, item.key);

      if (doi && !localByDOI.has(doi)) {
        localByDOI.set(doi, nodeID);
      }

      const normalizedTitle = normalizeTitle(node.title);
      if (normalizedTitle && !localByTitle.has(normalizedTitle)) {
        localByTitle.set(normalizedTitle, nodeID);
      }
    }

    updateProgress("Loading local relation data...", 26);
    await Promise.all(
      items.map(async (item) => {
        try {
          await item.loadDataType("relations");
        } catch (error) {
          ztoolkit.log("Failed loading item relations:", item.id, error);
        }
      }),
    );

    updateProgress("Reading local relations...", 30);
    for (const item of items) {
      const sourceNodeID = localByItemID.get(item.id);
      if (!sourceNodeID) continue;

      const relationCandidates = new Set<string>();

      for (const relationURI of item.getRelationsByPredicate("dc:relation")) {
        relationCandidates.add(relationURI);
      }

      const allRelations = item.getRelations();
      for (const relationValues of Object.values(allRelations || {})) {
        for (const relationValue of relationValues || []) {
          relationCandidates.add(relationValue);
        }
      }

      for (const relatedToken of item.relatedItems || []) {
        relationCandidates.add(relatedToken);
      }

      for (const relationToken of relationCandidates) {
        const targetNodeID = resolveLocalNodeIDFromToken(
          relationToken,
          localByItemID,
          localByItemKey,
        );
        if (!targetNodeID) continue;
        addEdge(edges, sourceNodeID, targetNodeID, "local");
      }

      const localDOIs = unique([
        ...extractDOIs(item.getField("references")),
        ...extractDOIs(item.getField("extra")),
      ]);
      for (const doi of localDOIs) {
        const targetNodeID = localByDOI.get(doi);
        if (!targetNodeID) continue;
        addEdge(edges, sourceNodeID, targetNodeID, "local");
      }
    }

    updateProgress("Applying cached local citation edges...", 34);
    applyCachedEdgesToGraph(
      cacheData,
      localByItemKey,
      localItemKeyByNodeID,
      edges,
    );

    if (
      !options.useOnlineLookup &&
      edges.size === 0 &&
      items.length <= MAX_QUICK_LOCAL_LOOKUP_ITEMS
    ) {
      updateProgress(
        "No local links found, running quick local citation indexing...",
        38,
      );

      const quickClient = new OpenAlexClient();
      const quickRefsByNodeID = new Map<string, string[]>();
      let quickResolvedCount = 0;

      for (const [itemID, nodeID] of localByItemID.entries()) {
        const sourceNode = nodes.get(nodeID);
        if (!sourceNode) continue;

        const sourceWork = await quickClient.resolveWork(sourceNode);
        quickResolvedCount += 1;
        updateProgress(
          `Quick index: ${quickResolvedCount}/${localByItemID.size}`,
          clampNumber(
            38 + (quickResolvedCount / localByItemID.size) * 8,
            38,
            46,
          ),
        );

        if (!sourceWork) continue;
        const sourceOpenAlexID = normalizeOpenAlexID(sourceWork.id);
        if (sourceOpenAlexID) {
          sourceNode.openAlexID = sourceOpenAlexID;
          localByOpenAlexID.set(sourceOpenAlexID, nodeID);
        }

        const referenceIDs = unique(
          (sourceWork.referenced_works || [])
            .slice(0, MAX_REFERENCES_PER_WORK)
            .map(normalizeOpenAlexID),
        );
        quickRefsByNodeID.set(nodeID, referenceIDs);
      }

      for (const [sourceNodeID, referenceIDs] of quickRefsByNodeID.entries()) {
        for (const referenceID of referenceIDs) {
          const targetNodeID = localByOpenAlexID.get(referenceID);
          if (!targetNodeID) continue;
          addEdge(edges, sourceNodeID, targetNodeID, "local");

          const sourceItemKey = localItemKeyByNodeID.get(sourceNodeID);
          const targetItemKey = localItemKeyByNodeID.get(targetNodeID);
          if (sourceItemKey && targetItemKey) {
            if (appendCacheEdge(cacheData, sourceItemKey, targetItemKey)) {
              cacheUpdated = true;
            }
          }
        }
      }
    }

    let truncated = false;
    if (options.useOnlineLookup) {
      updateProgress("Fetching citation graph online...", 40);
      const client = new OpenAlexClient();
      const externalByOpenAlexID = new Map<string, string>();
      let externalCounter = 0;

      const queue: Array<{ nodeID: string; depth: number }> = [];
      const queued = new Set<string>();
      const processed = new Set<string>();

      for (const nodeID of localByItemID.values()) {
        queue.push({ nodeID, depth: 0 });
        queued.add(nodeID);
      }

      let processedCount = 0;
      while (queue.length) {
        const current = queue.shift();
        if (!current || processed.has(current.nodeID)) continue;

        const sourceNode = nodes.get(current.nodeID);
        if (!sourceNode) continue;

        if (
          sourceNode.nodeType === "external" &&
          current.depth >= options.extensionDepth
        ) {
          processed.add(current.nodeID);
          continue;
        }

        processed.add(current.nodeID);
        processedCount += 1;
        updateProgress(
          `Online pass ${processedCount}, queue ${queue.length}`,
          Math.min(95, 40 + processedCount * 2),
        );

        const sourceWork = await client.resolveWork(sourceNode);
        if (!sourceWork) continue;

        const sourceOpenAlexID = normalizeOpenAlexID(sourceWork.id);
        if (sourceOpenAlexID) {
          sourceNode.openAlexID = sourceOpenAlexID;
          if (sourceNode.nodeType === "local") {
            localByOpenAlexID.set(sourceOpenAlexID, sourceNode.id);
          } else {
            externalByOpenAlexID.set(sourceOpenAlexID, sourceNode.id);
          }
        }

        const referenceIDs = unique(
          (sourceWork.referenced_works || [])
            .slice(0, MAX_REFERENCES_PER_WORK)
            .map(normalizeOpenAlexID),
        );
        if (!referenceIDs.length) continue;

        const refWorks = await client.getReferencedWorks(referenceIDs);
        for (const refID of referenceIDs) {
          const refWork = refWorks.get(refID);
          const localTargetID = this.findLocalTargetID(
            {
              openAlexID: refID,
              doi: normalizeDOI(refWork?.doi || ""),
              title: refWork?.display_name || "",
            },
            localByOpenAlexID,
            localByDOI,
            localByTitle,
          );

          if (localTargetID) {
            addEdge(edges, sourceNode.id, localTargetID, "remote");

            const sourceItemKey = localItemKeyByNodeID.get(sourceNode.id);
            const targetItemKey = localItemKeyByNodeID.get(localTargetID);
            if (sourceItemKey && targetItemKey) {
              if (appendCacheEdge(cacheData, sourceItemKey, targetItemKey)) {
                cacheUpdated = true;
              }
            }
            continue;
          }

          if (
            !options.includeExternalReferences ||
            current.depth >= options.extensionDepth
          ) {
            continue;
          }

          if (externalByOpenAlexID.size >= MAX_EXTERNAL_NODES) {
            truncated = true;
            continue;
          }

          let externalNodeID = externalByOpenAlexID.get(refID);
          if (!externalNodeID) {
            externalCounter += 1;
            externalNodeID = `external:${externalCounter}`;
            const title = refWork?.display_name || refID;
            nodes.set(externalNodeID, {
              id: externalNodeID,
              nodeType: "external",
              title,
              label: isOpenAlexPlaceholderTitle(title) ? "" : title,
              doi: normalizeDOI(refWork?.doi || ""),
              openAlexID: refID,
              depth: current.depth + 1,
            });
            externalByOpenAlexID.set(refID, externalNodeID);
          } else {
            const existingNode = nodes.get(externalNodeID);
            if (existingNode) {
              existingNode.depth = Math.min(
                existingNode.depth,
                current.depth + 1,
              );
            }
          }

          addEdge(edges, sourceNode.id, externalNodeID, "remote");

          const nextDepth = current.depth + 1;
          if (
            nextDepth < options.extensionDepth &&
            !queued.has(externalNodeID)
          ) {
            queue.push({ nodeID: externalNodeID, depth: nextDepth });
            queued.add(externalNodeID);
          }
        }
      }
    }

    updateProgress("Finalizing graph data...", 98);
    if (cacheUpdated) {
      cacheData.updatedAt = new Date().toISOString();
      saveCitationCacheData(cacheData);
    }

    return {
      collectionID: collection.id,
      collectionName: collection.name,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      subcollections: localScope.subcollections,
      options,
      truncated,
    };
  }

  private static collectLocalScopeData(
    rootCollection: Zotero.Collection,
  ): LocalScopeData {
    const itemByID = new Map<number, Zotero.Item>();
    const membershipByItemID = new Map<
      number,
      {
        isInRootCollection: boolean;
        subcollectionIDs: Set<number>;
        subcollectionPathByID: Map<number, string>;
      }
    >();
    const subcollectionByID = new Map<number, SubcollectionInfo>();

    const queue: Array<{
      collection: Zotero.Collection;
      path: string;
      depth: number;
      isRoot: boolean;
    }> = [
        {
          collection: rootCollection,
          path: rootCollection.name,
          depth: 0,
          isRoot: true,
        },
      ];
    const seenCollectionIDs = new Set<number>();

    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      if (seenCollectionIDs.has(current.collection.id)) continue;
      seenCollectionIDs.add(current.collection.id);

      const scopedItems = current.collection
        .getChildItems(false, false)
        .filter((item) => item.isRegularItem() && item.isTopLevelItem());

      for (const item of scopedItems) {
        itemByID.set(item.id, item);
        if (!membershipByItemID.has(item.id)) {
          membershipByItemID.set(item.id, {
            isInRootCollection: false,
            subcollectionIDs: new Set<number>(),
            subcollectionPathByID: new Map<number, string>(),
          });
        }

        const membership = membershipByItemID.get(item.id)!;
        if (current.isRoot) {
          membership.isInRootCollection = true;
        } else {
          membership.subcollectionIDs.add(current.collection.id);
          membership.subcollectionPathByID.set(
            current.collection.id,
            current.path,
          );
        }
      }

      const childCollections = ((current.collection as any).getChildCollections?.(
        false,
        false,
      ) || []) as Zotero.Collection[];

      for (const child of childCollections) {
        const childPath = `${current.path} / ${child.name}`;
        subcollectionByID.set(child.id, {
          id: child.id,
          name: child.name,
          path: childPath,
          depth: current.depth + 1,
          color: "",
        });

        if (!seenCollectionIDs.has(child.id)) {
          queue.push({
            collection: child,
            path: childPath,
            depth: current.depth + 1,
            isRoot: false,
          });
        }
      }
    }

    const itemMemberships = new Map<number, LocalItemMembership>();
    for (const [itemID, membership] of membershipByItemID.entries()) {
      const sortedSubcollectionIDs = [...membership.subcollectionIDs].sort(
        (left, right) => left - right,
      );
      const sortedPaths = sortedSubcollectionIDs
        .map((id) => membership.subcollectionPathByID.get(id) || "")
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));

      itemMemberships.set(itemID, {
        isInRootCollection: membership.isInRootCollection,
        subcollectionIDs: sortedSubcollectionIDs,
        subcollectionPaths: sortedPaths,
      });
    }

    const sortedSubcollections = [...subcollectionByID.values()].sort(
      (left, right) => left.path.localeCompare(right.path),
    );
    this.assignDistinctSubcollectionColors(sortedSubcollections);

    return {
      items: [...itemByID.values()],
      itemMemberships,
      subcollections: sortedSubcollections,
    };
  }

  private static findLocalTargetID(
    ref: { openAlexID?: string; doi?: string; title?: string },
    localByOpenAlexID: Map<string, string>,
    localByDOI: Map<string, string>,
    localByTitle: Map<string, string>,
  ) {
    if (ref.openAlexID) {
      const byOpenAlexID = localByOpenAlexID.get(ref.openAlexID);
      if (byOpenAlexID) return byOpenAlexID;
    }
    if (ref.doi) {
      const byDOI = localByDOI.get(ref.doi);
      if (byDOI) return byDOI;
    }
    if (ref.title) {
      const byTitle = localByTitle.get(normalizeTitle(ref.title));
      if (byTitle) return byTitle;
    }
    return undefined;
  }

  private static assignDistinctSubcollectionColors(
    subcollections: SubcollectionInfo[],
  ) {
    if (!subcollections.length) return;

    const candidates = buildSubcollectionColorCandidates();
    const selectedCandidates: ColorCandidate[] = [];
    const reservedLabs = [
      colorStringToLab(ROOT_LOCAL_NODE_COLOR),
      colorStringToLab(MULTI_SUBCOLLECTION_NODE_COLOR),
      colorStringToLab(EXTERNAL_NODE_COLOR),
    ].filter(Boolean) as LabColor[];

    for (const subcollection of subcollections) {
      const picked = this.pickMostDistinctColorCandidate(
        candidates,
        selectedCandidates,
        reservedLabs,
      );
      subcollection.color = picked.css;
      selectedCandidates.push(picked);
    }
  }

  private static pickMostDistinctColorCandidate(
    candidates: ColorCandidate[],
    selected: ColorCandidate[],
    reservedLabs: LabColor[],
  ) {
    if (!candidates.length) {
      return makeGeneratedColorCandidate(selected.length + reservedLabs.length);
    }

    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const minDistanceToSelected = selected.length
        ? Math.min(
          ...selected.map((entry) => labDistance(candidate.lab, entry.lab)),
        )
        : Number.POSITIVE_INFINITY;
      const minDistanceToReserved = reservedLabs.length
        ? Math.min(
          ...reservedLabs.map((entry) => labDistance(candidate.lab, entry)),
        )
        : Number.POSITIVE_INFINITY;

      const score = Math.min(minDistanceToSelected, minDistanceToReserved);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const [picked] = candidates.splice(bestIndex, 1);
    if (picked) {
      return picked;
    }

    return makeGeneratedColorCandidate(selected.length + reservedLabs.length);
  }

  private static filterGraphBySelectedSubcollections(
    data: CitationGraphData,
    selectedSubcollectionIDs: Set<number>,
  ) {
    const nodeByID = new Map(data.nodes.map((node) => [node.id, node]));
    const visibleLocalNodeIDs = new Set<string>();

    for (const node of data.nodes) {
      if (node.nodeType !== "local") continue;

      const scopedSubcollectionIDs = (node.subcollectionIDs || []).filter((id) =>
        selectedSubcollectionIDs.has(id),
      );
      const visible = Boolean(node.isInRootCollection) || scopedSubcollectionIDs.length > 0;
      if (visible) {
        visibleLocalNodeIDs.add(node.id);
      }
    }

    const scopedEdges = data.edges.filter((edge) => {
      const source = nodeByID.get(edge.source);
      const target = nodeByID.get(edge.target);
      if (!source || !target) return false;

      if (source.nodeType === "local" && !visibleLocalNodeIDs.has(source.id)) {
        return false;
      }
      if (target.nodeType === "local" && !visibleLocalNodeIDs.has(target.id)) {
        return false;
      }

      return true;
    });

    const edgeNodeIDs = new Set<string>();
    for (const edge of scopedEdges) {
      edgeNodeIDs.add(edge.source);
      edgeNodeIDs.add(edge.target);
    }

    const scopedNodes = data.nodes.filter((node) => {
      if (node.nodeType === "local") {
        return visibleLocalNodeIDs.has(node.id);
      }
      return edgeNodeIDs.has(node.id);
    });

    return {
      nodes: scopedNodes,
      edges: scopedEdges,
      visibleLocalNodeIDs,
    };
  }

  private static getLocalNodeColor(
    node: GraphNode,
    selectedSubcollectionIDs: Set<number>,
    subcollectionColorByID: Map<number, string>,
  ) {
    const selectedSubcollections = (node.subcollectionIDs || []).filter((id) =>
      selectedSubcollectionIDs.has(id),
    );

    if (selectedSubcollections.length === 0) {
      return ROOT_LOCAL_NODE_COLOR;
    }
    if (selectedSubcollections.length === 1) {
      return (
        subcollectionColorByID.get(selectedSubcollections[0]) ||
        ROOT_LOCAL_NODE_COLOR
      );
    }
    return MULTI_SUBCOLLECTION_NODE_COLOR;
  }

  private static getNodeColor(
    node: GraphNode,
    viewState: GraphViewState,
    subcollectionColorByID: Map<number, string>,
  ) {
    if (node.nodeType === "external") {
      return EXTERNAL_NODE_COLOR;
    }
    return this.getLocalNodeColor(
      node,
      viewState.selectedSubcollectionIDs,
      subcollectionColorByID,
    );
  }

  private static openGraphWindow(graphData: CitationGraphData) {
    const dialogData: Record<string, any> = {
      loadCallback: () => {
        this.initializeGraphWindow(dialog.window, graphData);
      },
    };

    const dialog = new ztoolkit.Dialog(3, 1)
      .addCell(
        0,
        0,
        {
          tag: "div",
          namespace: "html",
          id: "citation-graph-settings",
          styles: {
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            border: "1px solid #d0d0d0",
            borderRadius: "6px",
            background: "#f8fafc",
            fontSize: "12px",
            lineHeight: "1.4",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          },
        },
        false,
      )
      .addCell(
        1,
        0,
        {
          tag: "div",
          namespace: "html",
          id: "citation-graph-summary",
          styles: {
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            border: "1px solid #d0d0d0",
            borderRadius: "6px",
            background: "#f7f7f7",
            fontSize: "12px",
            lineHeight: "1.4",
          },
        },
        false,
      )
      .addCell(
        2,
        0,
        {
          tag: "div",
          namespace: "html",
          id: "citation-graph-container",
          styles: {
            width: "100%",
            height: "60vh",
            minHeight: "260px",
            border: "1px solid #d0d0d0",
            borderRadius: "6px",
            overflow: "hidden",
            marginTop: "8px",
            background: "#fff",
          },
        },
        false,
      )
      .addButton("Close", "close")
      .setDialogData(dialogData)
      .open("Citation Graph", {
        width: 1280,
        height: 900,
        centerscreen: true,
        noDialogMode: true,
        resizable: true,
      });
  }

  private static initializeGraphWindow(
    win: Window,
    initialData: CitationGraphData,
  ) {
    const doc = win.document;
    const settingsContainer = doc.getElementById("citation-graph-settings");
    const summary = doc.getElementById("citation-graph-summary");
    const graphContainer = doc.getElementById("citation-graph-container");
    if (!settingsContainer || !summary || !graphContainer) return;

    const viewState: GraphViewState = {
      hiddenNodeIDs: new Set(),
      hiddenEdgeKeys: new Set(),
      selectedSubcollectionIDs: new Set(
        initialData.subcollections.map((subcollection) => subcollection.id),
      ),
    };

    let currentData = initialData;

    const createInputLabel = (text: string) => {
      const label = doc.createElement("label");
      label.textContent = text;
      label.style.fontWeight = "600";
      label.style.marginRight = "2px";
      return label;
    };

    const useOnlineInput = doc.createElement("input");
    useOnlineInput.type = "checkbox";
    useOnlineInput.checked = initialData.options.useOnlineLookup;

    const includeExternalInput = doc.createElement("input");
    includeExternalInput.type = "checkbox";
    includeExternalInput.checked =
      initialData.options.includeExternalReferences;

    const depthInput = doc.createElement("input");
    depthInput.type = "number";
    depthInput.min = "0";
    depthInput.max = "5";
    depthInput.step = "1";
    depthInput.value = String(initialData.options.extensionDepth);
    depthInput.style.width = "64px";

    const collectionIDInput = doc.createElement("input");
    collectionIDInput.type = "number";
    collectionIDInput.min = "1";
    collectionIDInput.step = "1";
    collectionIDInput.value = String(initialData.collectionID);
    collectionIDInput.style.width = "100px";

    const reloadButton = doc.createElement("button");
    reloadButton.textContent = "Reload";
    reloadButton.style.padding = "4px 10px";
    reloadButton.style.border = "1px solid #cfd8e3";
    reloadButton.style.borderRadius = "6px";
    reloadButton.style.cursor = "pointer";
    reloadButton.style.background = "#fff";

    const resetViewButton = doc.createElement("button");
    resetViewButton.textContent = "Reset Hidden";
    resetViewButton.style.padding = "4px 10px";
    resetViewButton.style.border = "1px solid #cfd8e3";
    resetViewButton.style.borderRadius = "6px";
    resetViewButton.style.cursor = "pointer";
    resetViewButton.style.background = "#fff";

    const statusSpan = doc.createElement("span");
    statusSpan.style.color = "#64748b";
    statusSpan.style.fontSize = "12px";
    statusSpan.style.marginLeft = "6px";

    const subcollectionContainer = doc.createElement("div");
    subcollectionContainer.style.width = "100%";
    subcollectionContainer.style.marginTop = "6px";
    subcollectionContainer.style.paddingTop = "6px";
    subcollectionContainer.style.borderTop = "1px dashed #d7dde6";

    const subcollectionHeader = doc.createElement("div");
    subcollectionHeader.style.display = "flex";
    subcollectionHeader.style.alignItems = "center";
    subcollectionHeader.style.gap = "6px";
    subcollectionHeader.style.flexWrap = "wrap";

    const subcollectionLabel = doc.createElement("span");
    subcollectionLabel.style.fontWeight = "600";
    subcollectionLabel.textContent = "Subcollections";

    const selectAllSubcollectionsButton = doc.createElement("button");
    selectAllSubcollectionsButton.textContent = "All";
    selectAllSubcollectionsButton.style.padding = "2px 8px";
    selectAllSubcollectionsButton.style.border = "1px solid #cfd8e3";
    selectAllSubcollectionsButton.style.borderRadius = "6px";
    selectAllSubcollectionsButton.style.cursor = "pointer";
    selectAllSubcollectionsButton.style.background = "#fff";

    const clearSubcollectionsButton = doc.createElement("button");
    clearSubcollectionsButton.textContent = "None";
    clearSubcollectionsButton.style.padding = "2px 8px";
    clearSubcollectionsButton.style.border = "1px solid #cfd8e3";
    clearSubcollectionsButton.style.borderRadius = "6px";
    clearSubcollectionsButton.style.cursor = "pointer";
    clearSubcollectionsButton.style.background = "#fff";

    const subcollectionSelectionSummary = doc.createElement("span");
    subcollectionSelectionSummary.style.color = "#64748b";
    subcollectionSelectionSummary.style.fontSize = "12px";

    subcollectionHeader.append(
      subcollectionLabel,
      selectAllSubcollectionsButton,
      clearSubcollectionsButton,
      subcollectionSelectionSummary,
    );

    const subcollectionList = doc.createElement("div");
    subcollectionList.style.display = "flex";
    subcollectionList.style.flexWrap = "wrap";
    subcollectionList.style.gap = "6px 10px";
    subcollectionList.style.maxHeight = "120px";
    subcollectionList.style.overflow = "auto";
    subcollectionList.style.padding = "6px 0 2px";

    subcollectionContainer.append(subcollectionHeader, subcollectionList);

    settingsContainer.append(
      createInputLabel("Collection"),
      collectionIDInput,
      createInputLabel("Online"),
      useOnlineInput,
      createInputLabel("External"),
      includeExternalInput,
      createInputLabel("Depth"),
      depthInput,
      reloadButton,
      resetViewButton,
      statusSpan,
      subcollectionContainer,
    );

    const selectAllSubcollections = () => {
      viewState.selectedSubcollectionIDs = new Set(
        currentData.subcollections.map((subcollection) => subcollection.id),
      );
    };

    const renderSubcollectionFilters = () => {
      subcollectionList.textContent = "";
      const allSubcollections = currentData.subcollections;
      const total = allSubcollections.length;
      const selected = allSubcollections.filter((subcollection) =>
        viewState.selectedSubcollectionIDs.has(subcollection.id),
      ).length;
      subcollectionSelectionSummary.textContent = `${selected}/${total} selected`;

      if (!allSubcollections.length) {
        const emptyLabel = doc.createElement("span");
        emptyLabel.style.color = "#64748b";
        emptyLabel.style.fontSize = "12px";
        emptyLabel.textContent = "No descendant subcollections.";
        subcollectionList.appendChild(emptyLabel);
        return;
      }

      for (const subcollection of allSubcollections) {
        const option = doc.createElement("label");
        option.style.display = "inline-flex";
        option.style.alignItems = "center";
        option.style.gap = "6px";
        option.style.padding = "2px 4px";
        option.style.borderRadius = "6px";
        option.style.background = "#fff";
        option.title = subcollection.path;

        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = viewState.selectedSubcollectionIDs.has(
          subcollection.id,
        );
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            viewState.selectedSubcollectionIDs.add(subcollection.id);
          } else {
            viewState.selectedSubcollectionIDs.delete(subcollection.id);
          }
          renderSubcollectionFilters();
          renderCurrentGraph();
        });

        const swatch = doc.createElement("span");
        swatch.style.width = "10px";
        swatch.style.height = "10px";
        swatch.style.borderRadius = "999px";
        swatch.style.display = "inline-block";
        swatch.style.background = subcollection.color;
        swatch.style.border = "1px solid rgba(15,23,42,0.2)";

        const text = doc.createElement("span");
        text.style.fontSize = "12px";
        text.textContent = subcollection.path;

        option.append(checkbox, swatch, text);
        subcollectionList.appendChild(option);
      }
    };

    selectAllSubcollectionsButton.addEventListener("click", () => {
      selectAllSubcollections();
      renderSubcollectionFilters();
      renderCurrentGraph();
    });

    clearSubcollectionsButton.addEventListener("click", () => {
      viewState.selectedSubcollectionIDs.clear();
      renderSubcollectionFilters();
      renderCurrentGraph();
    });

    const fitGraphHeight = () => {
      const settingsRect = settingsContainer.getBoundingClientRect();
      const summaryRect = summary.getBoundingClientRect();
      const padding = 56;
      const targetHeight = Math.max(
        260,
        win.innerHeight - settingsRect.height - summaryRect.height - padding,
      );
      (graphContainer as HTMLElement).style.height = `${targetHeight}px`;
    };
    fitGraphHeight();
    win.addEventListener("resize", fitGraphHeight);

    const renderCurrentGraph = () => {
      this.renderGraph(doc, currentData, viewState, {
        onNodeContextMenu: (node, event, root) => {
          this.showNodeContextMenu(root, event.clientX, event.clientY, [
            {
              label: "Hide connected edges",
              action: () => {
                for (const edge of currentData.edges) {
                  if (edge.source === node.id || edge.target === node.id) {
                    viewState.hiddenEdgeKeys.add(
                      `${edge.source}->${edge.target}`,
                    );
                  }
                }
                renderCurrentGraph();
              },
            },
            {
              label: "Hide connected edges + isolated nodes",
              action: () => {
                for (const edge of currentData.edges) {
                  if (edge.source === node.id || edge.target === node.id) {
                    viewState.hiddenEdgeKeys.add(
                      `${edge.source}->${edge.target}`,
                    );
                  }
                }
                hideIsolatedNodes(currentData, viewState);
                renderCurrentGraph();
              },
            },
            {
              label: "Reset hidden",
              action: () => {
                viewState.hiddenEdgeKeys.clear();
                viewState.hiddenNodeIDs.clear();
                renderCurrentGraph();
              },
            },
          ]);
        },
      });
    };

    reloadButton.addEventListener("click", async () => {
      const collectionID = Number.parseInt(collectionIDInput.value, 10);
      if (!Number.isFinite(collectionID) || collectionID <= 0) {
        win.alert("Invalid collection ID.");
        return;
      }

      const options: CitationGraphOptions = {
        collectionID,
        useOnlineLookup: useOnlineInput.checked,
        includeExternalReferences: includeExternalInput.checked,
        extensionDepth: clampInt(depthInput.value, 0, 5, 0),
      };

      reloadButton.disabled = true;
      statusSpan.textContent = "Reloading graph...";
      try {
        const collection = await Zotero.Collections.getAsync(collectionID);
        currentData = await this.buildGraphData(collection, options, (msg) => {
          statusSpan.textContent = msg;
        });
        selectAllSubcollections();
        viewState.hiddenEdgeKeys.clear();
        viewState.hiddenNodeIDs.clear();
        renderSubcollectionFilters();
        renderCurrentGraph();
        fitGraphHeight();
        statusSpan.textContent = "Reload finished.";
      } catch (error) {
        ztoolkit.log("Reload graph failed:", error);
        statusSpan.textContent = `Reload failed: ${String(error)}`;
      } finally {
        reloadButton.disabled = false;
      }
    });

    resetViewButton.addEventListener("click", () => {
      viewState.hiddenEdgeKeys.clear();
      viewState.hiddenNodeIDs.clear();
      renderCurrentGraph();
    });

    renderSubcollectionFilters();
    renderCurrentGraph();
  }

  private static renderGraph(
    doc: Document,
    data: CitationGraphData,
    viewState: GraphViewState,
    callbacks?: GraphRenderCallbacks,
  ) {
    const summary = doc.getElementById("citation-graph-summary");
    const container = doc.getElementById("citation-graph-container");
    if (!summary || !container) return;

    const scopedGraph = this.filterGraphBySelectedSubcollections(
      data,
      viewState.selectedSubcollectionIDs,
    );
    const subcollectionColorByID = new Map(
      data.subcollections.map((subcollection) => [
        subcollection.id,
        subcollection.color,
      ]),
    );
    const subcollectionPathByID = new Map(
      data.subcollections.map((subcollection) => [
        subcollection.id,
        subcollection.path,
      ]),
    );

    const visibleNodes = scopedGraph.nodes.filter(
      (node) => !viewState.hiddenNodeIDs.has(node.id),
    );
    const visibleNodeIDs = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = scopedGraph.edges.filter((edge) => {
      const edgeKey = `${edge.source}->${edge.target}`;
      if (viewState.hiddenEdgeKeys.has(edgeKey)) return false;
      return visibleNodeIDs.has(edge.source) && visibleNodeIDs.has(edge.target);
    });

    const selectedSubcollectionCount = data.subcollections.filter(
      (subcollection) =>
        viewState.selectedSubcollectionIDs.has(subcollection.id),
    ).length;
    const localNodeCount = scopedGraph.nodes.filter(
      (node) => node.nodeType === "local",
    ).length;

    summary.textContent = [
      `Collection: ${data.collectionName} (#${data.collectionID})`,
      `Nodes: ${visibleNodes.length}/${scopedGraph.nodes.length}`,
      `Edges: ${visibleEdges.length}/${scopedGraph.edges.length}`,
      `Local in scope: ${localNodeCount}`,
      `Subcollections: ${selectedSubcollectionCount}/${data.subcollections.length}`,
      `Online: ${data.options.useOnlineLookup ? "yes" : "no"}`,
      `Include external: ${data.options.includeExternalReferences ? "yes" : "no"}`,
      `Depth: ${data.options.extensionDepth}`,
      !data.options.useOnlineLookup
        ? "Offline mode includes cached/quick local citation links."
        : "",
      data.truncated ? "External nodes truncated at hard limit." : "",
    ]
      .filter(Boolean)
      .join(" | ");

    container.textContent = "";
    const root = doc.createElementNS(XHTML_NS, "div") as unknown as HTMLElement;
    root.setAttribute(
      "style",
      "position:relative;width:100%;height:100%;font-family:Segoe UI, sans-serif;background:linear-gradient(180deg,#f6f8fa 0%,#ffffff 100%);",
    );
    container.appendChild(root);

    const hoverTooltip = doc.createElementNS(
      XHTML_NS,
      "div",
    ) as unknown as HTMLElement;
    hoverTooltip.setAttribute(
      "style",
      [
        "position:absolute",
        "z-index:30",
        "display:none",
        "pointer-events:none",
        "max-width:320px",
        "padding:7px 9px",
        "border-radius:8px",
        "background:rgba(15,23,42,0.92)",
        "color:#f8fafc",
        "font-size:12px",
        "line-height:1.35",
        "box-shadow:0 10px 26px rgba(2,6,23,0.28)",
        "border:1px solid rgba(148,163,184,0.35)",
        "white-space:normal",
      ].join(";"),
    );
    root.appendChild(hoverTooltip);

    let tooltipTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTooltipNode: GraphNode | undefined;
    let pendingTooltipX = 0;
    let pendingTooltipY = 0;

    const setTooltipPosition = (clientX: number, clientY: number) => {
      const rootRect = root.getBoundingClientRect();
      const tooltipRect = hoverTooltip.getBoundingClientRect();
      const maxX = Math.max(8, rootRect.width - tooltipRect.width - 8);
      const maxY = Math.max(8, rootRect.height - tooltipRect.height - 8);
      const x = clampNumber(clientX - rootRect.left + NODE_TOOLTIP_OFFSET_X, 8, maxX);
      const y = clampNumber(clientY - rootRect.top + NODE_TOOLTIP_OFFSET_Y, 8, maxY);
      hoverTooltip.style.left = `${x}px`;
      hoverTooltip.style.top = `${y}px`;
    };

    const hideNodeTooltip = () => {
      if (tooltipTimer) {
        clearTimeout(tooltipTimer);
        tooltipTimer = undefined;
      }
      pendingTooltipNode = undefined;
      hoverTooltip.style.display = "none";
      hoverTooltip.textContent = "";
    };

    const showNodeTooltip = (node: GraphNode, clientX: number, clientY: number) => {
      const lines = buildNodeTooltipLines(node, viewState, subcollectionPathByID);
      hoverTooltip.textContent = "";
      for (const line of lines) {
        const row = doc.createElement("div");
        row.textContent = line;
        hoverTooltip.appendChild(row);
      }
      hoverTooltip.style.display = "block";
      setTooltipPosition(clientX, clientY);
    };

    const scheduleNodeTooltip = (node: GraphNode, clientX: number, clientY: number) => {
      if (tooltipTimer) {
        clearTimeout(tooltipTimer);
        tooltipTimer = undefined;
      }
      pendingTooltipNode = node;
      pendingTooltipX = clientX;
      pendingTooltipY = clientY;
      tooltipTimer = setTimeout(() => {
        if (!pendingTooltipNode) return;
        showNodeTooltip(pendingTooltipNode, pendingTooltipX, pendingTooltipY);
      }, NODE_TOOLTIP_DELAY_MS);
    };

    const updateNodeTooltipPosition = (clientX: number, clientY: number) => {
      pendingTooltipX = clientX;
      pendingTooltipY = clientY;
      if (hoverTooltip.style.display !== "none") {
        setTooltipPosition(clientX, clientY);
      }
    };

    const svg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGSVGElement;
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.cursor = "grab";
    root.appendChild(svg);

    const defs = doc.createElementNS(SVG_NS, "defs");
    const marker = doc.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "citation-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto");
    const markerPath = doc.createElementNS(SVG_NS, "path");
    markerPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    markerPath.setAttribute("fill", "#6b7280");
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const viewport = doc.createElementNS(SVG_NS, "g");
    svg.appendChild(viewport);

    let scale = 1;
    let tx = 0;
    let ty = 0;
    const updateLabelScale = () => {
      const labelScale = clampNumber(1 / Math.pow(scale, 0.65), 0.28, 1);
      const labels = viewport.querySelectorAll(
        "text[data-node-label='1']",
      ) as NodeListOf<SVGTextElement>;
      labels.forEach((label: SVGTextElement) => {
        const x = Number(label.getAttribute("x") || "0");
        const y = Number(label.getAttribute("y") || "0");
        label.setAttribute(
          "transform",
          `translate(${x} ${y}) scale(${labelScale}) translate(${-x} ${-y})`,
        );
        label.setAttribute("stroke-width", String(2 / labelScale));
      });
    };
    const applyTransform = () => {
      viewport.setAttribute(
        "transform",
        `matrix(${scale} 0 0 ${scale} ${tx} ${ty})`,
      );
      updateLabelScale();
    };
    const clientToViewbox = (clientX: number, clientY: number) => {
      const rect = svg.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * VIEWBOX_WIDTH,
        y: ((clientY - rect.top) / rect.height) * VIEWBOX_HEIGHT,
      };
    };
    const zoomAt = (x: number, y: number, factor: number) => {
      const nextScale = clampNumber(scale * factor, 0.2, 8);
      if (nextScale === scale) return;
      tx = x - (x - tx) * (nextScale / scale);
      ty = y - (y - ty) * (nextScale / scale);
      scale = nextScale;
      applyTransform();
    };
    applyTransform();

    svg.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const isPinch = Boolean(event.ctrlKey || event.metaKey);
        const isTrackpadPan =
          event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
          !isPinch &&
          (Math.abs(event.deltaX) > 0.01 || Math.abs(event.deltaY) > 0.01);

        if (isPinch) {
          const point = clientToViewbox(event.clientX, event.clientY);
          const factor = clampNumber(
            Math.exp(-event.deltaY * PINCH_SENSITIVITY),
            0.92,
            1.08,
          );
          zoomAt(point.x, point.y, factor);
          return;
        }

        if (isTrackpadPan) {
          tx -= (event.deltaX / rect.width) * VIEWBOX_WIDTH;
          ty -= (event.deltaY / rect.height) * VIEWBOX_HEIGHT;
          applyTransform();
          return;
        }

        const point = clientToViewbox(event.clientX, event.clientY);
        zoomAt(
          point.x,
          point.y,
          event.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR,
        );
      },
      { passive: false },
    );

    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;

    svg.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0) return;
      const tagName = (event.target as Element)?.tagName?.toLowerCase() || "";
      if (tagName === "circle" || tagName === "text" || tagName === "tspan") {
        return;
      }
      isPanning = true;
      panStartX = event.clientX;
      panStartY = event.clientY;
      svg.style.cursor = "grabbing";
    });

    svg.addEventListener("mousemove", (event: MouseEvent) => {
      if (!isPanning) return;
      const rect = svg.getBoundingClientRect();
      const dx = ((event.clientX - panStartX) / rect.width) * VIEWBOX_WIDTH;
      const dy = ((event.clientY - panStartY) / rect.height) * VIEWBOX_HEIGHT;
      panStartX = event.clientX;
      panStartY = event.clientY;
      tx += dx;
      ty += dy;
      applyTransform();
    });

    svg.addEventListener("mouseup", () => {
      if (!isPanning) return;
      isPanning = false;
      svg.style.cursor = "grab";
    });
    svg.addEventListener("mouseleave", () => {
      hideNodeTooltip();
      if (!isPanning) return;
      isPanning = false;
      svg.style.cursor = "grab";
    });

    const positions = this.computeLayout(
      visibleNodes,
      VIEWBOX_WIDTH,
      VIEWBOX_HEIGHT,
    );

    for (const edge of visibleEdges) {
      const sourcePos = positions.get(edge.source);
      const targetPos = positions.get(edge.target);
      if (!sourcePos || !targetPos) continue;
      const lineData = shortenLine(sourcePos, targetPos);
      if (!lineData) continue;

      const line = doc.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(lineData.x1));
      line.setAttribute("y1", String(lineData.y1));
      line.setAttribute("x2", String(lineData.x2));
      line.setAttribute("y2", String(lineData.y2));
      line.setAttribute(
        "stroke",
        edge.relation === "local" ? "#8a8f98" : "#64748b",
      );
      line.setAttribute(
        "stroke-width",
        edge.relation === "local" ? "1.4" : "1.1",
      );
      line.setAttribute("opacity", "0.7");
      line.setAttribute("marker-end", "url(#citation-arrow)");
      viewport.appendChild(line);
    }

    for (const node of visibleNodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;

      const group = doc.createElementNS(SVG_NS, "g");
      group.setAttribute("cursor", "pointer");

      const circle = doc.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(pos.x));
      circle.setAttribute("cy", String(pos.y));
      circle.setAttribute("r", String(pos.r));
      circle.setAttribute("fill", this.getNodeColor(node, viewState, subcollectionColorByID));
      circle.setAttribute(
        "opacity",
        node.nodeType === "local" ? "0.95" : "0.8",
      );
      circle.setAttribute("stroke", "#ffffff");
      circle.setAttribute("stroke-width", "1.5");
      group.appendChild(circle);

      if (node.label) {
        const label = doc.createElementNS(
          SVG_NS,
          "text",
        ) as unknown as SVGTextElement;
        label.setAttribute("x", String(pos.x));
        label.setAttribute("y", String(pos.y + pos.r + 13));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "11");
        label.setAttribute("fill", "#1f2937");
        label.setAttribute("data-node-label", "1");
        label.setAttribute("paint-order", "stroke");
        label.setAttribute("stroke", "rgba(255,255,255,0.85)");
        label.setAttribute("stroke-width", "2");
        label.setAttribute("stroke-linejoin", "round");
        appendWrappedSvgText(doc, label, node.label, 30);
        group.appendChild(label);
      }

      group.addEventListener("mouseenter", (event: MouseEvent) => {
        scheduleNodeTooltip(node, event.clientX, event.clientY);
      });
      group.addEventListener("mousemove", (event: MouseEvent) => {
        updateNodeTooltipPosition(event.clientX, event.clientY);
      });
      group.addEventListener("mouseleave", () => {
        hideNodeTooltip();
      });

      group.addEventListener("click", () => {
        hideNodeTooltip();
        this.handleNodeClick(node);
      });
      group.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        hideNodeTooltip();
        callbacks?.onNodeContextMenu?.(node, event, root);
      });
      viewport.appendChild(group);
    }

    updateLabelScale();

    const legend = doc.createElementNS(XHTML_NS, "div");
    legend.setAttribute(
      "style",
      [
        "position:absolute",
        "right:10px",
        "top:10px",
        "padding:8px 10px",
        "border-radius:6px",
        "background:rgba(255,255,255,0.92)",
        "border:1px solid #d0d0d0",
        "font-size:12px",
        "line-height:1.5",
        "color:#334155",
      ].join(";"),
    );
    legend.textContent =
      "Blue: root-scope local item | Subcollection colors: see checkbox chips | Gray: item in multiple selected subcollections | Orange: external paper | Mouse wheel: zoom | Touchpad two-finger move: pan | Pinch: zoom";
    root.appendChild(legend);

    const controls = doc.createElementNS(XHTML_NS, "div");
    controls.setAttribute(
      "style",
      [
        "position:absolute",
        "left:10px",
        "top:10px",
        "display:flex",
        "gap:6px",
      ].join(";"),
    );
    root.appendChild(controls);

    const addControlButton = (label: string, onClick: () => void) => {
      const button = doc.createElementNS(XHTML_NS, "button");
      button.textContent = label;
      button.setAttribute(
        "style",
        [
          "border:1px solid #cfd8e3",
          "background:#ffffff",
          "border-radius:6px",
          "font-size:12px",
          "padding:4px 8px",
          "cursor:pointer",
        ].join(";"),
      );
      button.addEventListener("click", onClick);
      controls.appendChild(button);
    };

    addControlButton("+", () =>
      zoomAt(VIEWBOX_WIDTH / 2, VIEWBOX_HEIGHT / 2, 1.2),
    );
    addControlButton("-", () =>
      zoomAt(VIEWBOX_WIDTH / 2, VIEWBOX_HEIGHT / 2, 0.84),
    );
    addControlButton("Reset", () => {
      scale = 1;
      tx = 0;
      ty = 0;
      applyTransform();
    });
  }

  private static computeLayout(
    nodes: GraphNode[],
    width: number,
    height: number,
  ) {
    const groups = new Map<number, GraphNode[]>();
    for (const node of nodes) {
      const depth = Math.max(0, node.depth);
      if (!groups.has(depth)) groups.set(depth, []);
      groups.get(depth)!.push(node);
    }

    const centerX = width / 2;
    const centerY = height / 2;
    const baseRadius = Math.min(width, height) * 0.19;
    const depthGap = Math.min(width, height) * 0.17;
    const positions = new Map<string, NodePosition>();
    const depths = [...groups.keys()].sort((a, b) => a - b);

    for (const depth of depths) {
      const depthNodes = groups.get(depth) || [];
      depthNodes.sort((a, b) => a.title.localeCompare(b.title));
      if (!depthNodes.length) continue;

      if (depth === 0 && depthNodes.length === 1) {
        const node = depthNodes[0];
        positions.set(node.id, {
          x: centerX,
          y: centerY,
          r: node.nodeType === "local" ? 12 : 9,
        });
        continue;
      }

      const radius = depth === 0 ? baseRadius : baseRadius + depth * depthGap;
      const angleOffset = depth * (Math.PI / 8);
      const angleStep = (2 * Math.PI) / depthNodes.length;

      depthNodes.forEach((node, index) => {
        const angle = angleOffset + index * angleStep;
        positions.set(node.id, {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
          r: node.nodeType === "local" ? 12 : 8,
        });
      });
    }

    return positions;
  }

  private static handleNodeClick(node: GraphNode) {
    if (node.itemID) {
      const mainWin = Zotero.getMainWindow();
      if (!mainWin) return;
      mainWin.Zotero_Tabs.select("zotero-pane");
      void mainWin.ZoteroPane.selectItem(node.itemID);
      return;
    }

    if (node.doi) {
      Zotero.launchURL(`https://doi.org/${node.doi}`);
      return;
    }

    if (node.openAlexID) {
      Zotero.launchURL(`https://openalex.org/${node.openAlexID}`);
    }
  }

  private static showNodeContextMenu(
    root: HTMLElement,
    clientX: number,
    clientY: number,
    actions: Array<{ label: string; action: () => void }>,
  ) {
    const menuDoc = root.ownerDocument;
    if (!menuDoc) return;

    root.querySelector("#citation-graph-node-menu")?.remove();

    const rect = root.getBoundingClientRect();
    const menu = menuDoc.createElement("div");
    menu.id = "citation-graph-node-menu";
    menu.style.position = "absolute";
    menu.style.left = `${clientX - rect.left}px`;
    menu.style.top = `${clientY - rect.top}px`;
    menu.style.zIndex = "20";
    menu.style.minWidth = "210px";
    menu.style.background = "#ffffff";
    menu.style.border = "1px solid #cbd5e1";
    menu.style.borderRadius = "8px";
    menu.style.boxShadow = "0 8px 24px rgba(2, 6, 23, 0.18)";
    menu.style.padding = "6px";

    for (const item of actions) {
      const button = menuDoc.createElement("button");
      button.textContent = item.label;
      button.style.display = "block";
      button.style.width = "100%";
      button.style.textAlign = "left";
      button.style.border = "none";
      button.style.background = "transparent";
      button.style.padding = "7px 8px";
      button.style.borderRadius = "6px";
      button.style.cursor = "pointer";
      button.addEventListener("mouseenter", () => {
        button.style.background = "#f1f5f9";
      });
      button.addEventListener("mouseleave", () => {
        button.style.background = "transparent";
      });
      button.addEventListener("click", () => {
        menu.remove();
        item.action();
      });
      menu.appendChild(button);
    }

    const closeMenu = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node)) {
        menu.remove();
        menuDoc.removeEventListener("click", closeMenu);
      }
    };
    menuDoc.addEventListener("click", closeMenu);
    root.appendChild(menu);
  }
}

function buildNodeTooltipLines(
  node: GraphNode,
  viewState: GraphViewState,
  subcollectionPathByID: Map<number, string>,
) {
  const tooltipLines: string[] = [node.title];

  if (node.nodeType === "local") {
    if (node.firstAuthor) {
      tooltipLines.push(`First author: ${node.firstAuthor}`);
    }
    if (node.lastAuthor) {
      tooltipLines.push(`Last author: ${node.lastAuthor}`);
    }
    if (node.itemDate) {
      tooltipLines.push(`Date: ${node.itemDate}`);
    }
  }

  if (node.doi) {
    tooltipLines.push(`DOI: ${node.doi}`);
  }

  if (node.nodeType === "local") {
    if (node.isInRootCollection) {
      tooltipLines.push("Root collection: yes");
    }
    if (node.subcollectionPaths?.length) {
      tooltipLines.push(`Subcollections: ${node.subcollectionPaths.join(" | ")}`);
    }
    const selectedPaths = (node.subcollectionIDs || [])
      .filter((id) => viewState.selectedSubcollectionIDs.has(id))
      .map((id) => subcollectionPathByID.get(id) || `#${id}`);
    if (selectedPaths.length > 1) {
      tooltipLines.push(
        `Visible via multiple selected subcollections (${selectedPaths.length})`,
      );
    }
  }

  return tooltipLines.filter(Boolean);
}

function extractLocalNodeAuthorAndDate(item: Zotero.Item) {
  const creators = (((item as any).getCreators?.() || []) as any[]).filter(
    (creator) => creator,
  );
  const authorLikeCreators = creators.filter((creator) => {
    const typeName = getCreatorTypeName(creator);
    return typeName === "author" || typeName === "inventor";
  });
  const creatorsForHover = authorLikeCreators.length
    ? authorLikeCreators
    : creators;

  let firstAuthor = creatorsForHover.length
    ? formatCreatorName(creatorsForHover[0])
    : undefined;
  let lastAuthor = creatorsForHover.length
    ? formatCreatorName(creatorsForHover[creatorsForHover.length - 1])
    : undefined;

  // Fallback for edge cases where creator names are unavailable.
  const firstCreatorField = String((item as any).firstCreator || "").trim();
  if (!firstAuthor && firstCreatorField) {
    firstAuthor = firstCreatorField;
  }
  if (!lastAuthor && firstCreatorField) {
    lastAuthor = firstCreatorField;
  }

  const itemDate = String(item.getField("date") || "").trim() || undefined;
  return {
    firstAuthor,
    lastAuthor,
    itemDate,
  };
}

function formatCreatorName(creator: any): string | undefined {
  const singleFieldName = String(creator?.name || "").trim();
  if (singleFieldName) {
    return singleFieldName;
  }

  const lastName = String(creator?.lastName || "").trim();
  const firstName = String(creator?.firstName || "").trim();

  if (lastName && firstName) {
    return `${lastName}, ${firstName}`;
  }
  if (lastName) {
    return lastName;
  }
  if (firstName) {
    return firstName;
  }
  return undefined;
}

function getCreatorTypeName(creator: any) {
  const directType = String(
    creator?.creatorType || creator?.creatorTypeName || "",
  )
    .trim()
    .toLowerCase();
  if (directType) {
    return directType;
  }

  const creatorTypeID = Number.parseInt(String(creator?.creatorTypeID), 10);
  if (
    Number.isFinite(creatorTypeID) &&
    (Zotero as any).CreatorTypes?.getName
  ) {
    try {
      return String((Zotero as any).CreatorTypes.getName(creatorTypeID) || "")
        .trim()
        .toLowerCase();
    } catch (_error) {
      return "";
    }
  }

  return "";
}

function addEdge(
  edgeMap: Map<string, GraphEdge>,
  source: string,
  target: string,
  relation: GraphEdge["relation"],
) {
  if (!source || !target || source === target) return;
  const edgeKey = `${source}->${target}`;
  if (edgeMap.has(edgeKey)) return;
  edgeMap.set(edgeKey, { source, target, relation });
}

function hideIsolatedNodes(data: CitationGraphData, viewState: GraphViewState) {
  const degree = new Map<string, number>();
  for (const node of data.nodes) {
    if (viewState.hiddenNodeIDs.has(node.id)) continue;
    degree.set(node.id, 0);
  }

  for (const edge of data.edges) {
    const edgeKey = `${edge.source}->${edge.target}`;
    if (viewState.hiddenEdgeKeys.has(edgeKey)) continue;
    if (!degree.has(edge.source) || !degree.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }

  for (const [nodeID, d] of degree.entries()) {
    if (d === 0) {
      viewState.hiddenNodeIDs.add(nodeID);
    }
  }
}

function applyCachedEdgesToGraph(
  cacheData: CitationCacheData,
  localByItemKey: Map<string, string>,
  localItemKeyByNodeID: Map<string, string>,
  edges: Map<string, GraphEdge>,
) {
  for (const [sourceKey, targetKeys] of Object.entries(
    cacheData.edgesBySourceKey || {},
  )) {
    const sourceNodeID = localByItemKey.get(sourceKey);
    if (!sourceNodeID) continue;

    for (const targetKey of targetKeys || []) {
      const targetNodeID = localByItemKey.get(targetKey);
      if (!targetNodeID) continue;
      addEdge(edges, sourceNodeID, targetNodeID, "local");
    }
  }

  // Ensure we only keep keys in canonical uppercase form
  for (const [nodeID, itemKey] of localItemKeyByNodeID.entries()) {
    if (itemKey !== itemKey.toUpperCase()) {
      localItemKeyByNodeID.set(nodeID, itemKey.toUpperCase());
    }
  }
}

function appendCacheEdge(
  cacheData: CitationCacheData,
  sourceItemKey: string,
  targetItemKey: string,
) {
  const sourceKey = sourceItemKey.toUpperCase();
  const targetKey = targetItemKey.toUpperCase();
  if (sourceKey === targetKey) return false;

  if (!cacheData.edgesBySourceKey[sourceKey]) {
    cacheData.edgesBySourceKey[sourceKey] = [];
  }

  const targets = cacheData.edgesBySourceKey[sourceKey];
  if (targets.includes(targetKey)) return false;
  targets.push(targetKey);
  return true;
}

function loadCitationCacheData(): CitationCacheData {
  const fallback: CitationCacheData = {
    version: 1,
    updatedAt: "",
    edgesBySourceKey: {},
  };

  try {
    const raw = Zotero.Prefs.get(getCitationCachePrefKey(), true) as
      | string
      | undefined;
    if (!raw || typeof raw !== "string") return fallback;

    const parsed = JSON.parse(raw) as Partial<CitationCacheData>;
    if (!parsed || typeof parsed !== "object") return fallback;

    const edgesBySourceKey: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed.edgesBySourceKey || {})) {
      if (!Array.isArray(value)) continue;
      edgesBySourceKey[key.toUpperCase()] = unique(
        value.map((token) => String(token || "").toUpperCase()),
      );
    }

    return {
      version: 1,
      updatedAt: String(parsed.updatedAt || ""),
      edgesBySourceKey,
    };
  } catch (error) {
    ztoolkit.log("Failed loading citation cache:", error);
    return fallback;
  }
}

function saveCitationCacheData(cacheData: CitationCacheData) {
  try {
    const compact: CitationCacheData = {
      version: 1,
      updatedAt: cacheData.updatedAt,
      edgesBySourceKey: cacheData.edgesBySourceKey,
    };
    Zotero.Prefs.set(getCitationCachePrefKey(), JSON.stringify(compact), true);
  } catch (error) {
    ztoolkit.log("Failed saving citation cache:", error);
  }
}

function getCitationCachePrefKey() {
  return `${addon.data.config.prefsPrefix}.citationGraphCache`;
}

function normalizeDOI(value: string | undefined) {
  if (!value) return undefined;
  let doi = value.trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  doi = doi.replace(/^doi:\s*/i, "");
  doi = doi.replace(/\s+/g, "");
  const match = doi.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].toLowerCase() : undefined;
}

function normalizeOpenAlexID(value: string | undefined) {
  if (!value) return undefined;
  const match = value.match(/W\d+/i);
  return match ? match[0].toUpperCase() : undefined;
}

function resolveLocalNodeIDFromToken(
  token: string,
  localByItemID: Map<number, string>,
  localByItemKey: Map<string, string>,
) {
  const normalizedToken = (token || "").trim();
  if (!normalizedToken) return undefined;

  if (localByItemKey.has(normalizedToken)) {
    return localByItemKey.get(normalizedToken);
  }

  const extractedKey = extractItemKeyFromToken(normalizedToken);
  if (extractedKey && localByItemKey.has(extractedKey)) {
    return localByItemKey.get(extractedKey);
  }

  try {
    const relationInfo = Zotero.URI.getURIItemLibraryKey(normalizedToken);
    if (
      relationInfo &&
      relationInfo.key &&
      localByItemKey.has(relationInfo.key)
    ) {
      return localByItemKey.get(relationInfo.key);
    }
  } catch (_error) {
    // Ignore malformed relation tokens
  }

  try {
    const itemID = Zotero.URI.getURIItemID(normalizedToken);
    if (itemID && localByItemID.has(itemID)) {
      return localByItemID.get(itemID);
    }
  } catch (_error) {
    // Ignore malformed relation URIs
  }

  return undefined;
}

function extractItemKeyFromToken(token: string) {
  const keyMatch = token.match(/([A-Z0-9]{8})$/i);
  return keyMatch ? keyMatch[1].toUpperCase() : undefined;
}

function isOpenAlexPlaceholderTitle(title: string | undefined) {
  if (!title) return false;
  return /^W\d+$/i.test(title.trim());
}

function extractDOIs(text: string | undefined) {
  if (!text) return [];
  const matches = text.match(DOI_PATTERN) || [];
  return unique(matches.map((match) => normalizeDOI(match)));
}

function normalizeTitle(title: string | undefined) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;
  const leftSet = new Set(left.split(" "));
  const rightSet = new Set(right.split(" "));
  const intersection = [...leftSet].filter((word) => rightSet.has(word)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : 0;
}

function unique<T>(values: Array<T | undefined | null>) {
  const result: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (value === undefined || value === null || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function chunk<T>(arr: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function clampNumber(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function buildSubcollectionColorCandidates() {
  const candidates: ColorCandidate[] = [];
  const seen = new Set<string>();

  for (const baseColor of SUBCOLLECTION_PALETTE) {
    const normalized = baseColor.toLowerCase();
    if (seen.has(normalized)) continue;
    const lab = colorStringToLab(normalized);
    if (!lab) continue;
    candidates.push({ css: normalized, lab });
    seen.add(normalized);
  }

  const hueStep = 12;
  const saturations = [64, 72, 80];
  const lightnesses = [42, 50, 58];
  for (let hue = 0; hue < 360; hue += hueStep) {
    for (const saturation of saturations) {
      for (const lightness of lightnesses) {
        const candidateColor = rgbToHex(
          hslToRgb(hue, saturation / 100, lightness / 100),
        );
        if (seen.has(candidateColor)) continue;
        const lab = colorStringToLab(candidateColor);
        if (!lab) continue;
        candidates.push({ css: candidateColor, lab });
        seen.add(candidateColor);
      }
    }
  }

  return candidates;
}

function makeGeneratedColorCandidate(seed: number): ColorCandidate {
  for (let attempt = 0; attempt < 2048; attempt += 1) {
    const n = seed + attempt;
    const hue = (n * 137.508) % 360;
    const saturation = (60 + ((Math.floor(n / 13) % 5) * 7)) / 100;
    const lightness = (40 + ((Math.floor(n / 29) % 4) * 7)) / 100;
    const css = rgbToHex(hslToRgb(hue, saturation, lightness));
    const lab = colorStringToLab(css);
    if (!lab) continue;
    return { css, lab };
  }

  const fallback = "#5b8def";
  return {
    css: fallback,
    lab: colorStringToLab(fallback) || { l: 58, a: 18, b: -46 },
  };
}

function colorStringToLab(color: string): LabColor | undefined {
  const rgb = parseHexColor(color) || parseHslColor(color);
  if (!rgb) return undefined;
  return rgbToLab(rgb);
}

function parseHexColor(color: string) {
  const trimmed = (color || "").trim();
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return undefined;

  const raw = hex[1].toLowerCase();
  const full =
    raw.length === 3
      ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
      : raw;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function parseHslColor(color: string) {
  const trimmed = (color || "").trim();
  const match = trimmed.match(
    /^hsl\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/i,
  );
  if (!match) return undefined;

  const h = Number.parseFloat(match[1]);
  const s = clampNumber(Number.parseFloat(match[2]) / 100, 0, 1);
  const l = clampNumber(Number.parseFloat(match[3]) / 100, 0, 1);
  return hslToRgb(h, s, l);
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (h < 60) {
    rPrime = c;
    gPrime = x;
  } else if (h < 120) {
    rPrime = x;
    gPrime = c;
  } else if (h < 180) {
    gPrime = c;
    bPrime = x;
  } else if (h < 240) {
    gPrime = x;
    bPrime = c;
  } else if (h < 300) {
    rPrime = x;
    bPrime = c;
  } else {
    rPrime = c;
    bPrime = x;
  }

  return {
    r: Math.round((rPrime + m) * 255),
    g: Math.round((gPrime + m) * 255),
    b: Math.round((bPrime + m) * 255),
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }) {
  const toHex = (value: number) =>
    clampInt(value, 0, 255, 0).toString(16).padStart(2, "0");
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function rgbToLab(rgb: { r: number; g: number; b: number }): LabColor {
  const r = srgbToLinear(rgb.r / 255);
  const g = srgbToLinear(rgb.g / 255);
  const b = srgbToLinear(rgb.b / 255);

  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

  const xr = x / 0.95047;
  const yr = y / 1.0;
  const zr = z / 1.08883;

  const fx = labPivot(xr);
  const fy = labPivot(yr);
  const fz = labPivot(zr);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function srgbToLinear(channel: number) {
  if (channel <= 0.04045) {
    return channel / 12.92;
  }
  return Math.pow((channel + 0.055) / 1.055, 2.4);
}

function labPivot(value: number) {
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  if (value > epsilon) {
    return Math.cbrt(value);
  }
  return (kappa * value + 16) / 116;
}

function labDistance(left: LabColor, right: LabColor) {
  const dl = left.l - right.l;
  const da = left.a - right.a;
  const db = left.b - right.b;
  return Math.hypot(dl, da, db);
}

function appendWrappedSvgText(
  doc: Document,
  textElement: SVGTextElement,
  content: string,
  lineCharLimit = 22,
) {
  const lines = splitTextIntoLines(content, lineCharLimit);
  lines.forEach((line, index) => {
    const tspan = doc.createElementNS(SVG_NS, "tspan");
    tspan.setAttribute("x", textElement.getAttribute("x") || "0");
    tspan.setAttribute("dy", index === 0 ? "0" : "1.15em");
    tspan.textContent = line;
    textElement.appendChild(tspan);
  });
}

function splitTextIntoLines(text: string, lineCharLimit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  if (!/\s/.test(normalized)) {
    const chunks: string[] = [];
    for (let i = 0; i < normalized.length; i += lineCharLimit) {
      chunks.push(normalized.slice(i, i + lineCharLimit));
    }
    return chunks;
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > lineCharLimit && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function shortenLine(source: NodePosition, target: NodePosition) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return null;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const padding = 6;
  return {
    x1: source.x + unitX * source.r,
    y1: source.y + unitY * source.r,
    x2: target.x - unitX * (target.r + padding),
    y2: target.y - unitY * (target.r + padding),
  };
}
