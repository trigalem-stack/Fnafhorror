const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Хранилище лобби
const lobbies = {};

// Хранилище игровых данных
const gameWorlds = {}; // lobbyId -> { players: {}, trees: [], campfire: {...} }

// Цвета игроков
const playerColors = [
    '#ff4444', '#44ff44', '#4444ff', '#ffff44', '#ff44ff', 
    '#44ffff', '#ff8844', '#8844ff', '#44ff88', '#ff4488'
];
let colorIndex = 0;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentLobby = null;
    let playerColor = playerColors[colorIndex % playerColors.length];
    colorIndex++;

    socket.on('setNickname', (nickname) => {
        socket.nickname = nickname;
        socket.playerColor = playerColor;
        socket.emit('loginSuccess');
        socket.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('createLobby', (data) => {
        const lobbyId = 'lobby_' + Date.now();
        lobbies[lobbyId] = {
            id: lobbyId,
            name: data.name,
            password: data.password,
            maxPlayers: parseInt(data.maxPlayers),
            admin: socket.id,
            players: [{ id: socket.id, name: socket.nickname, color: socket.playerColor }],
            isPlaying: false
        };
        socket.join(lobbyId);        currentLobby = lobbyId;
        
        socket.emit('lobbyJoined', lobbies[lobbyId]);
        io.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('joinLobby', (data) => {
        const lobby = lobbies[data.id];
        if (!lobby) return socket.emit('errorMsg', 'Лобби не найдено');
        if (lobby.isPlaying) return socket.emit('errorMsg', 'Игра уже идёт');
        if (lobby.players.length >= lobby.maxPlayers) return socket.emit('errorMsg', 'Лобби заполнено');
        if (lobby.password && lobby.password !== data.password) return socket.emit('errorMsg', 'Неверный пароль');

        lobby.players.push({ id: socket.id, name: socket.nickname, color: socket.playerColor });
        socket.join(lobby.id);
        currentLobby = lobby.id;

        io.to(lobby.id).emit('lobbyUpdated', lobby);
        io.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('kickPlayer', (playerId) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            const playerSocket = io.sockets.sockets.get(playerId);
            if (playerSocket) {
                playerSocket.leave(lobby.id);
                playerSocket.emit('kicked');
            }
            lobby.players = lobby.players.filter(p => p.id !== playerId);
            io.to(lobby.id).emit('lobbyUpdated', lobby);
            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    socket.on('disbandLobby', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            io.to(lobby.id).emit('lobbyDisbanded');
            lobby.players.forEach(p => {
                const pSocket = io.sockets.sockets.get(p.id);
                if (pSocket) pSocket.leave(lobby.id);
            });
            delete lobbies[currentLobby];
            if (gameWorlds[currentLobby]) delete gameWorlds[currentLobby];
            currentLobby = null;
            io.emit('updateLobbyList', getLobbiesList());
        }    });

    socket.on('leaveLobby', () => {
        handleLeaveLobby(socket);
    });

    socket.on('leaveGame', () => {
        handleLeaveLobby(socket);
    });

    socket.on('startGame', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            lobby.isPlaying = true;

            // Initialize game world
            gameWorlds[lobby.id] = {
                players: {}
            };

            // Send game start to all players with their colors
            lobby.players.forEach(p => {
                const pSocket = io.sockets.sockets.get(p.id);
                if (pSocket) {
                    pSocket.emit('gameStarted', {
                        myColor: p.color,
                        players: lobby.players
                    });
                }
            });

            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    // Player movement in game
    socket.on('playerMove', (data) => {
        if (!currentLobby || !gameWorlds[currentLobby]) return;
        const world = gameWorlds[currentLobby];
        world.players[socket.id] = {
            id: socket.id,
            name: socket.nickname,
            color: socket.playerColor,
            x: data.x,
            y: data.y,
            z: data.z,
            yaw: data.yaw,
            pitch: data.pitch
        };    });

    socket.on('disconnect', () => {
        handleLeaveLobby(socket);
    });
});

function handleLeaveLobby(socket) {
    const currentLobby = Object.keys(lobbies).find(id => {
        return lobbies[id].players.some(p => p.id === socket.id);
    });
    
    if (!currentLobby || !lobbies[currentLobby]) return;
    const lobby = lobbies[currentLobby];
    
    socket.leave(lobby.id);
    
    if (lobby.admin === socket.id) {
        io.to(lobby.id).emit('lobbyDisbanded');
        delete lobbies[currentLobby];
        if (gameWorlds[currentLobby]) delete gameWorlds[currentLobby];
    } else {
        lobby.players = lobby.players.filter(p => p.id !== socket.id);
        io.to(lobby.id).emit('lobbyUpdated', lobby);
        // Remove from game world
        if (gameWorlds[currentLobby] && gameWorlds[currentLobby].players[socket.id]) {
            delete gameWorlds[currentLobby].players[socket.id];
        }
    }
    io.emit('updateLobbyList', getLobbiesList());
}

function getLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPlaying).map(l => ({
        id: l.id,
        name: l.name,
        hasPassword: !!l.password,
        playersCount: l.players.length,
        maxPlayers: l.maxPlayers
    }));
}

// Broadcast player positions every 100ms
setInterval(() => {
    Object.keys(gameWorlds).forEach(lobbyId => {
        const world = gameWorlds[lobbyId];
        if (!world) return;
        const players = Object.values(world.players);
        if (players.length === 0) return;
                // Send to all players in this lobby
        const lobby = lobbies[lobbyId];
        if (!lobby) return;
        
        lobby.players.forEach(p => {
            const pSocket = io.sockets.sockets.get(p.id);
            if (pSocket) {
                pSocket.emit('playerPositions', players);
            }
        });
    });
}, 100);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
