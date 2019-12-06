import { PeerJSServerConnection } from "./peerjs-server-connector/peerjsserverconnection";
import { ServerMessage } from "./peerjs-server-connector/servermessage";
import { ServerMessageType } from "./peerjs-server-connector/enums";
import SimplePeer, { SignalData } from "simple-peer";
import { isReliable, connectionIdFor } from "./peerjs-server-connector/util";
import { SocketBuilder } from "./peerjs-server-connector/socket";

export type User = string;
export type Room = { id: string; users: Set<User> };

export interface IPeer {
  nickname: string;
  currentRooms: Room[];
  callback: (sender: string, room: string, payload: any) => void;
  joinRoom(room: string): Promise<void>;
  sendMessage(room: string, payload: any, reliable?: boolean): Promise<void>;
}

type PeerData = {
  id: string;
  reliableConnection: SimplePeer.Instance;
  unreliableConnection: SimplePeer.Instance;
};

const PeerSignals = { offer: "offer", answer: "answer" };

const defaultConnectionConfig = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    },
    {
      urls: "stun:stun2.l.google.com:19302"
    },
    {
      urls: "stun:stun3.l.google.com:19302"
    },
    {
      urls: "stun:stun4.l.google.com:19302"
    }
  ]
};

function signalMessage(
  peer: PeerData,
  connectionId: string,
  signal: SignalData
) {
  if (isReliable(connectionId)) {
    peer.reliableConnection.signal(signal);
  } else {
    peer.unreliableConnection.signal(signal);
  }
}

type PeerConfig = {
  connectionConfig?: any;
  wrtc?: any;
  socketBuilder?: SocketBuilder;
};
export class Peer implements IPeer {
  private peerJsConnection: PeerJSServerConnection;
  private peers: Record<string, PeerData> = {};

  public readonly currentRooms: Room[] = [];
  private connectionConfig: any;
  private wrtc: any;

  constructor(
    private lighthouseUrl: string,
    public nickname: string,
    public callback: (
      sender: string,
      room: string,
      payload: any
    ) => void = () => {},
    config: PeerConfig = {}
  ) {
    const url = new URL(lighthouseUrl);
    this.peerJsConnection = new PeerJSServerConnection(this, nickname, {
      host: url.hostname,
      port: url.port ? parseInt(url.port) : 80,
      path: url.pathname,
      ...(config.socketBuilder ? { socketBuilder: config.socketBuilder } : {})
    });

    this.wrtc = config.wrtc;

    this.connectionConfig = {
      ...defaultConnectionConfig,
      ...(config.connectionConfig || {})
    };
  }

  async joinRoom(roomId: string): Promise<void> {
    const room: { id: string }[] = await fetch(
      `${this.lighthouseUrl}/rooms/${roomId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ id: this.nickname })
      }
    ).then(res => res.json());

    this.currentRooms.push({
      id: roomId,
      users: new Set(room.map(user => user.id))
    });

    room
      .filter(
        user => user.id !== this.nickname && !this.hasConnectionsFor(user.id)
      )
      .forEach(user => this.getOrCreatePeer(user.id, true));
  }

  private hasConnectionsFor(userId: string) {
    return !!this.peers[userId];
  }

  private subscribeToConnection(
    peerId: string,
    connection: SimplePeer.Instance,
    reliable: boolean
  ) {
    connection.on("signal", this.handleSignal(peerId, reliable));
    connection.on("connect", () => {
      console.log(
        "CONNECTED to " +
          peerId +
          " through " +
          connectionIdFor(this.nickname, peerId, reliable)
      );
      /*
       * TODO: Currently there is no way of knowing for an incomming
       * connection to which room the othe peer belongs, so we are adding them
       * to the all the rooms. There are multiple options:
       * - We refresh all the rooms when a user connects
       * - We make the peers exchange their rooms as their first messages
       * - We make the rooms a part of the handshake
       */
      this.currentRooms.forEach(it => it.users.add(peerId));
    });

    connection.on("data", data => {
      // if (data instanceof Uint8Array)
      //   data = new TextDecoder("utf-8").decode(data);
      const parsed = JSON.parse(data);
      this.callback(peerId, parsed.room, parsed.payload);
    });
  }

  sendMessage(roomId: string, payload: any, reliable: boolean = true) {
    const room = this.currentRooms.find(room => room.id === roomId);
    if (!room) {
      return Promise.reject(
        `cannot send a message in a room not joined (${roomId})`
      );
    }

    [...room.users]
      .filter(user => user !== this.nickname)
      .forEach(user => this.sendMessageTo(user, roomId, payload, reliable));

    return Promise.resolve();
  }

  private sendMessageTo(
    user: string,
    roomId: string,
    payload: any,
    reliable: boolean
  ) {
    const peer = this.peers[user];
    if (peer) {
      const connection = reliable
        ? "reliableConnection"
        : "unreliableConnection";
      const conn = peer[connection];
      if (!conn.writableEnded) {
        conn?.write(
          JSON.stringify({
            room: roomId,
            payload
          })
        );
      }
    }
  }

  private handleSignal(peerId: string, reliable: boolean) {
    const connectionId = connectionIdFor(this.nickname, peerId, reliable);
    return (data: SignalData) => {
      console.log("Signal from peer " + peerId, data);
      if (data.type === PeerSignals.offer) {
        this.peerJsConnection.sendOffer(peerId, data, connectionId);
      } else if (data.type === PeerSignals.answer) {
        this.peerJsConnection.sendAnswer(peerId, data, connectionId);
      } else if (data.candidate) {
        this.peerJsConnection.sendCandidate(peerId, data, connectionId);
      }
    };
  }

  private getOrCreatePeer(peerId: string, initiator: boolean = false) {
    let peer = this.peers[peerId];
    if (!peer) {
      peer = this.peers[peerId] = {
        id: peerId,
        reliableConnection: new SimplePeer({
          initiator,
          config: this.connectionConfig,
          channelConfig: {
            label: connectionIdFor(this.nickname, peerId, true)
          },
          wrtc: this.wrtc,
          objectMode: true
        }),
        unreliableConnection: new SimplePeer({
          initiator,
          config: this.connectionConfig,
          channelConfig: {
            label: connectionIdFor(this.nickname, peerId, false),
            ordered: false,
            maxPacketLifetime: 1000 //This value should be aligned with frame refreshes. Maybe configurable?
          },
          wrtc: this.wrtc,
          objectMode: true
        })
      };

      this.subscribeToConnection(peerId, peer.reliableConnection, true);
      this.subscribeToConnection(peerId, peer.unreliableConnection, false);
    }
    return peer;
  }

  handleMessage(message: ServerMessage): void {
    const { type, payload, src: peerId } = message;
    switch (type) {
      case ServerMessageType.Offer:
      case ServerMessageType.Answer: {
        const peer = this.getOrCreatePeer(peerId);
        signalMessage(peer, payload.connectionId, payload.sdp);
        break;
      }
      case ServerMessageType.Candidate: {
        const peer = this.getOrCreatePeer(peerId);
        signalMessage(peer, payload.connectionId, {
          candidate: payload.candidate
        });
      }
    }
  }
}