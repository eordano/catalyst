import { IRealm } from "peerjs-server";
import { PeerInfo, PeerRequest } from "./types";
import { Position, discretizedPositionDistance, PeerConnectionHint } from "decentraland-katalyst-utils/Positions";

export enum NotificationType {
  PEER_LEFT_ROOM = "PEER_LEFT_ROOM",
  PEER_LEFT_LAYER = "PEER_LEFT_LAYER",
  PEER_JOINED_LAYER = "PEER_JOINED_LAYER",
  PEER_JOINED_ROOM = "PEER_JOINED_ROOM"
}

require("isomorphic-fetch");

export interface IPeersService {
  notifyPeersById(peerIds: string[], type: NotificationType, payload: object): void;

  getPeerInfo(peerId: string): PeerInfo;
  getPeersInfo(peerIds: string[]): PeerInfo[];

  ensurePeerInfo(peer: PeerRequest): PeerInfo;
  getOptimalConnectionsFor(peer: PeerInfo, otherPeers: PeerInfo[], targetConnections: number, maxDistance: number): PeerConnectionHint[];
}

export class PeersService implements IPeersService {
  private peersTopology: Record<string, string[]> = {};
  private peers: Record<string, PeerInfo> = {};

  constructor(private realmProvider: () => IRealm, private distanceFunction: (p1: Position, p2: Position) => number = discretizedPositionDistance) {}

  notifyPeers(peers: PeerInfo[], type: NotificationType, payload: object) {
    this.notifyPeersById(
      peers.map(it => it.id),
      type,
      payload
    );
  }

  notifyPeersById(peerIds: string[], type: NotificationType, payload: object) {
    console.log(`Sending ${type} notification to: `, peerIds);
    peerIds.forEach(id => {
      const client = this.peerRealm!.getClientById(id);
      if (client) {
        client.send({
          type,
          src: "__lighthouse_notification__",
          dst: id,
          payload
        });
      }
    });
  }

  updateTopology(peerId: string, connectedPeerIds: string[]) {
    this.peersTopology[peerId] = connectedPeerIds;
  }

  private get peerRealm() {
    return this.realmProvider();
  }

  getConnectedPeers(peerId: string): string[] | undefined {
    return this.peersTopology[peerId];
  }

  peerExistsInRealm(peerId: string) {
    return !!this.peerRealm.getClientById(peerId);
  }

  getPeerInfo(peerId: string): PeerInfo {
    return this.peers[peerId] ?? { id: peerId };
  }

  getPeersInfo(peerIds: string[]): PeerInfo[] {
    return peerIds.map(id => this.getPeerInfo(id));
  }

  ensurePeerInfo(peer: PeerRequest): PeerInfo {
    const peerId = (peer.id ?? peer.peerId)!;
    const existing = this.peers[peerId];

    if (existing) {
      if (existing.protocolVersion) {
        existing.protocolVersion = peer.protocolVersion;
      }
      return existing;
    } else {
      this.peers[peerId] = { id: peerId, protocolVersion: peer.protocolVersion };
      return this.peers[peerId];
    }
  }

  updatePeerParcel(peerId: string, parcel?: [number, number]) {
    if (this.peers[peerId]) {
      this.peers[peerId].parcel = parcel;
    }
  }

  updatePeerPosition(peerId: string, position?: Position) {
    if (this.peers[peerId]) {
      this.peers[peerId].position = position;
    }
  }

  getOptimalConnectionsFor(peer: PeerInfo, otherPeers: PeerInfo[], targetConnections: number, maxDistance: number): PeerConnectionHint[] {
    const hints: PeerConnectionHint[] = [];

    otherPeers.forEach(it => {
      if (it.id !== peer.id && it.position) {
        const distance = this.distanceFunction(peer.position!, it.position);
        if (distance <= maxDistance) {
          hints.push({
            id: it.id,
            distance,
            position: it.position
          });
        }
      }
    });

    return hints
      .sort((h1, h2) => {
        const distanceDiff = h1.distance - h2.distance;
        // If the distance is the same, we randomize
        return distanceDiff === 0 ? Math.random() : distanceDiff;
      })
      // We don't send more than 100 peer positions for now
      .slice(0, 100);
  }
}
