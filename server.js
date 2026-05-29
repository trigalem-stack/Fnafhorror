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

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentLobby = null;

    // Установка ника
    socket.on('setNickname', (nickname) => {
        socket.nickname = nickname;
        socket.emit('loginSuccess');
        socket.emit('updateLobbyList', getLobbiesList());
    });

    // Создание лобби
    socket.on('createLobby', (data) => {
        const lobbyId = 'lobby_' + Date.now();
        lobbies[lobbyId] = {
            id: lobbyId,
            name: data.name,
            password: data.password,
            maxPlayers: data.maxPlayers,
            admin: socket.id,
            players: [{ id: socket.id, name: socket.nickname }],
            isPlaying: false
        };
        socket.join(lobbyId);
        currentLobby = lobbyId;
        
        socket.emit('lobbyJoined', lobbies[lobbyId]);
        io.emit('updateLobbyList', getLobbiesList());
    });

    // Вход в лобби
    socket.on('joinLobby', (data) => {
        const lobby = lobbies[data.id];
        if (!lobby) return socket.emit('errorMsg', 'Лобби не найдено');
        if (lobby.isPlaying) return socket.emit('errorMsg', 'Игра уже началась');
        if (lobby.players.length >= lobby.maxPlayers) return socket.emit('errorMsg', 'Лобби заполнено');
        if (lobby.password && lobby.password !== data.password) return socket.emit('errorMsg', 'Неверный пароль');

        lobby.players.push({ id: socket.id, name: socket.nickname });
        socket.join(lobby.id);
        currentLobby = lobby.id;

        io.to(lobby.id).emit('lobbyUpdated', lobby);
        io.emit('updateLobbyList', getLobbiesList());
    });

    // Кик игрока админом
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

    // Распустить лобби
    socket.on('disbandLobby', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            io.to(lobby.id).emit('lobbyDisbanded');
            // Принудительно выгоняем всех из комнаты
            lobby.players.forEach(p => {
                const pSocket = io.sockets.sockets.get(p.id);
                if (pSocket) pSocket.leave(lobby.id);
            });
            delete lobbies[currentLobby];
            currentLobby = null;
            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    // Выход из лобби по своей воле
    socket.on('leaveLobby', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        
        socket.leave(lobby.id);
        
        if (lobby.admin === socket.id) {
            // Если вышел админ - распускаем
            io.to(lobby.id).emit('lobbyDisbanded');
            delete lobbies[currentLobby];
        } else {
            // Обычный игрок
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            io.to(lobby.id).emit('lobbyUpdated', lobby);
        }
        currentLobby = null;
        io.emit('updateLobbyList', getLobbiesList());
    });

    // Старт игры
    socket.on('startGame', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (lobby.admin === socket.id) {
            lobby.isPlaying = true;
            io.to(lobby.id).emit('gameStarted');
            io.emit('updateLobbyList', getLobbiesList());
        }
    });

    socket.on('disconnect', () => {
        if (currentLobby && lobbies[currentLobby]) {
            const lobby = lobbies[currentLobby];
            if (lobby.admin === socket.id) {
                io.to(lobby.id).emit('lobbyDisbanded');
                delete lobbies[currentLobby];
            } else {
                lobby.players = lobby.players.filter(p => p.id !== socket.id);
                io.to(lobby.id).emit('lobbyUpdated', lobby);
            }
            io.emit('updateLobbyList', getLobbiesList());
        }
    });
});

function getLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPlaying).map(l => ({
        id: l.id,
        name: l.name,
        hasPassword: !!l.password,
        playersCount: l.players.length,
        maxPlayers: l.maxPlayers
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
