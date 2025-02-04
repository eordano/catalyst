import cors from "cors";
import express from "express";
import morgan from "morgan";
import { ExpressPeerServer, IRealm } from "peerjs-server";
import { IConfig } from "peerjs-server/dist/src/config";
import { PeersService } from "./peersService";
import { configureRoutes } from "./routes";
import { LayersService } from "./layersService";
import { Metrics } from "decentraland-katalyst-commons/metrics";
import { IMessage } from "peerjs-server/dist/src/models/message";
import { IClient } from "peerjs-server/dist/src/models/client";
import { MessageType } from "peerjs-server/dist/src/enums";
import * as path from "path";
import { DEFAULT_LAYERS } from "./default_layers";
import { Authenticator } from "dcl-crypto";
import { pickName } from "./naming";
import { patchLog } from "./logging";
import { DAOClient } from "decentraland-katalyst-commons/DAOClient";
import { httpProviderForNetwork } from "decentraland-katalyst-contracts/utils";
import { DAOContract } from "decentraland-katalyst-contracts/DAOContract";

const LIGHTHOUSE_VERSION = "0.1";
const DEFAULT_ETH_NETWORK = "ropsten";

const CURRENT_ETH_NETWORK = process.env.ETH_NETWORK ?? DEFAULT_ETH_NETWORK;

(async function() {
  const daoClient = new DAOClient(DAOContract.withNetwork(CURRENT_ETH_NETWORK));

  const name = await pickName(process.env.LIGHTHOUSE_NAMES, daoClient);
  console.info("Picked name: " + name);

  patchLog(name);

  const accessLogs = parseBoolean(process.env.ACCESS ?? "false");
  const port = parseInt(process.env.PORT ?? "9000");
  const noAuth = parseBoolean(process.env.NO_AUTH ?? "false")
  const secure = parseBoolean(process.env.SECURE ?? "false");
  const enableMetrics = parseBoolean(process.env.METRICS ?? "false");
  const allowNewLayers = parseBoolean(process.env.ALLOW_NEW_LAYERS ?? "false");
  const maxUsersPerLayer = parseInt(process.env.MAX_PER_LAYER ?? "50");
  const existingLayers = process.env.DEFAULT_LAYERS?.split(",").map(it => it.trim()) ?? DEFAULT_LAYERS;

  function parseBoolean(string: string) {
    return string.toLowerCase() === "true";
  }

  const app = express();

  if (enableMetrics) {
    Metrics.initialize(app);
  }

  const peersService = new PeersService(getPeerJsRealm);

  app.use(cors());
  app.use(express.json());
  if (accessLogs) {
    app.use(morgan("combined"));
  }

  const layersService = new LayersService({ peersService, maxPeersPerLayer: maxUsersPerLayer, existingLayers, allowNewLayers });

  configureRoutes(
    app,
    { layersService, realmProvider: getPeerJsRealm, peersService },
    {
      name,
      version: LIGHTHOUSE_VERSION,
      env: {
        secure,
        commitHash: process.env.COMMIT_HASH
      }
    }
  );

  const server = app.listen(port, async () => {
    console.info(`==> Lighthouse listening on port ${port}.`);
  });

  const options: Partial<IConfig> = {
    path: "/",
    authHandler: async (client, message) => {
      if (noAuth) {
        return true;
      }

      if (!client) {
        // client not registered
        return false;
      }
      if (client.getId().toLocaleLowerCase() !== message.payload[0]?.payload?.toLocaleLowerCase()) {
        // client id mistmaches with auth signer
        return false;
      }
      try {
        const provider = httpProviderForNetwork(CURRENT_ETH_NETWORK);
        const result = await Authenticator.validateSignature(client.getMsg(), message.payload, provider);

        return result.ok;
      } catch (e) {
        console.log(`error while recovering address for client ${client.getId()}`, e);
        return false;
      }
    }
  };

  const peerServer = ExpressPeerServer(server, options);

  peerServer.on("disconnect", (client: any) => {
    console.log("User disconnected from server socket. Removing from all rooms & layers: " + client.id);
    layersService.removePeer(client.id);
  });

  peerServer.on("error", console.log);

  //@ts-ignore
  peerServer.on("message", (client: IClient, message: IMessage) => {
    if (message.type === MessageType.HEARTBEAT) {
      peersService.updateTopology(client.getId(), message.payload?.connectedPeerIds);
      peersService.updatePeerParcel(client.getId(), message.payload?.parcel);
      peersService.updatePeerPosition(client.getId(), message.payload?.position)

      if(message.payload?.optimizeNetwork) {
        const optimalConnectionsResult = layersService.getOptimalConnectionsFor(client.getId(), message.payload.targetConnections, message.payload.maxDistance)
        client.send({
          type: "OPTIMAL_NETWORK_RESPONSE",
          src: "__lighthouse_response__",
          dst: client.getId(),
          payload: optimalConnectionsResult
        })
      }
    }
  });

  function getPeerJsRealm(): IRealm {
    return peerServer.get("peerjs-realm");
  }

  app.use("/peerjs", peerServer);

  const _static = path.join(__dirname, "../static");

  app.use("/monitor", express.static(_static + "/monitor"));
})().catch(e => {
  console.error("Exiting process because of unhandled exception", e);
  process.exit(1);
});
