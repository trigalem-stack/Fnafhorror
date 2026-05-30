const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const lobbies = {};

const DAY_NIGHT_DURATION = 6 * 60 * 1000; // 6 минут
const MAX_SPEED = 6.0 * 1.3; // Увеличена скорость
const TPS_INTERVAL = 50; // 20 TPS

io.on('connection', (socket) => {
    let currentLobby = null;

    socket.on('pingRequest', () => { socket.emit('pongResponse'); });

    socket.on('setNickname', (nickname) => {
        socket.nickname = nickname; socket.emit('loginSuccess'); socket.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('createLobby', (data) => {
        if (Object.values(lobbies).some(l => l.name.toLowerCase() === data.name.toLowerCase())) {
            return socket.emit('errorMsg', 'Лобби с таким названием уже существует!');
        }

        const lobbyId = 'lobby_' + Date.now();
        const trees = [];
        for (let i = 0; i < 50; i++) {
            let tx = (Math.random() - 0.5) * 60; let tz = (Math.random() - 0.5) * 60; // Радиус 30 (60x60)
            if (Math.sqrt(tx*tx + tz*tz) < 8) { tx += 10; tz += 10; }
            trees.push({ id: 'tree_' + i, x: Number(tx.toFixed(2)), z: Number(tz.toFixed(2)), hp: 4, isCut: false, sinkY: 0 });
        }

        lobbies[lobbyId] = {
            id: lobbyId, name: data.name, password: data.password, maxPlayers: data.maxPlayers,
            admin: socket.id, players: [], isPlaying: false,
            world: {
                day: 1, isNight: false, timeProgress: 0, uidCounter: 500, lastRegenTime: Date.now(),
                campfire: { x: 0, z: 0, hp: 100, level: 1 },
                workbench: { x: 3, z: 3, wood: 0, iron: 0, bedCrafted: false },
                recycler: { x: 1.8, z: 3 }, 
                trees: trees, droppedLogs: [], saplings: [], wolves: [], droppedSaplings: [], beds: [], droppedBeds: [],
                houses: [], droppedChairs: [], droppedBolts: [], clocks: [], droppedClocks: [],
                mapRadius: 30, // Изначальный радиус (60х60)
                tps: 20
            }
        };
        socket.join(lobbyId); currentLobby = lobbyId; joinLobbyAction(socket, lobbies[lobbyId]);
    });

    socket.on('joinLobby', (data) => {
        const lobby = lobbies[data.id];
        if (!lobby) return socket.emit('errorMsg', 'Лобби не найдено');
        if (lobby.isPlaying) return socket.emit('errorMsg', 'Игра уже началась');
        if (lobby.players.length >= lobby.maxPlayers) return socket.emit('errorMsg', 'Лобби заполнено');
        if (lobby.password && lobby.password !== data.password) return socket.emit('errorMsg', 'Неверный пароль');
        socket.join(lobby.id); currentLobby = lobby.id; joinLobbyAction(socket, lobby);
    });

    function joinLobbyAction(socket, lobby) {
        const colors = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff, 0xffa500, 0xffffff];
        lobby.players.push({ 
            id: socket.id, name: socket.nickname,
            x: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 + 4, ry: 0,
            color: colors[lobby.players.length % colors.length], bag: [], hp: 100, 
            lastUpdate: Date.now(), ping: 50
        });
        io.to(lobby.id).emit('lobbyUpdated', lobby); io.emit('updateLobbyList', getLobbiesList());
    }

    socket.on('playerUpdate', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const p = lobbies[currentLobby].players.find(pl => pl.id === socket.id);
        if (p && p.hp > 0) {
            const now = Date.now();
            const dt = (now - p.lastUpdate) / 1000;
            if (dt > 0.05) {
                const dist = Math.sqrt(Math.pow(data.x - p.x, 2) + Math.pow(data.z - p.z, 2));
                const tolerance = (data.ping && data.ping > 150) ? 2.0 : 0.5;
                if (dist / dt > MAX_SPEED + tolerance) {
                    socket.emit('forceMove', { x: p.x, z: p.z }); p.lastUpdate = now; return; 
                }
            }
            p.lastUpdate = now; p.ping = data.ping || 50; p.x = data.x; p.z = data.z; p.ry = data.ry; 
        }
    });

    socket.on('hitEntity', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        
        if(data.type === 'tree') {
            const tree = lobby.world.trees.find(t => t.id === data.id && !t.isCut);
            if (tree) {
                tree.hp -= 1; io.to(lobby.id).emit('treeHit', data.id); 
                if (tree.hp <= 0) {
                    tree.isCut = true;
                    for (let k = 0; k < 3; k++) {
                        lobby.world.uidCounter++;
                        let ox = (Math.random() - 0.5) * 1.2; let oz = (Math.random() - 0.5) * 1.2;
                        lobby.world.droppedLogs.push({ id: 'log_' + lobby.world.uidCounter, x: tree.x + ox, y: 0.5 + k*0.2, z: tree.z + oz, collected: false });
                    }
                    lobby.world.uidCounter++;
                    lobby.world.droppedSaplings.push({ id: 'sap_' + lobby.world.uidCounter, x: tree.x + (Math.random() - 0.5)*1.5, y: 0.3, z: tree.z + (Math.random() - 0.5)*1.5, collected: false });
                }
                io.to(lobby.id).emit('treeUpdated', tree);
            }
        } else if(data.type === 'wolf') {
            const wolf = lobby.world.wolves.find(w => w.id === data.id);
            if(wolf) { wolf.hp -= 25; if(wolf.hp <= 0) lobby.world.wolves = lobby.world.wolves.filter(w => w.id !== data.id); }
        }
    });

    socket.on('placeItem', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        lobby.world.uidCounter++;
        if(data.type === 'sapling') lobby.world.saplings.push({ id: 'sapling_' + lobby.world.uidCounter, x: data.x, z: data.z, stage: 0, timer: 0 });
        else if (data.type === 'bed') lobby.world.beds.push({ id: 'bed_' + lobby.world.uidCounter, x: data.x, z: data.z });
        else if (data.type === 'clock') lobby.world.clocks.push({ id: 'clock_' + lobby.world.uidCounter, x: data.x, z: data.z });
    });

    socket.on('craftItem', (type) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if (type === 'bed' && lobby.world.workbench.wood >= 15 && !lobby.world.workbench.bedCrafted) {
            lobby.world.workbench.wood -= 15; lobby.world.workbench.bedCrafted = true; socket.emit('itemToSlot', 'bed');
        } else if (type === 'clock' && lobby.world.workbench.wood >= 4 && lobby.world.workbench.iron >= 2) {
            lobby.world.workbench.wood -= 4; lobby.world.workbench.iron -= 2; socket.emit('itemToSlot', 'clock');
        }
    });

    socket.on('collectItem', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.hp <= 0) return;

        let arr = null; let bagItemType = null; let slotItemType = null;
        if(data.type === 'log') { arr = lobby.world.droppedLogs; bagItemType = 'log'; }
        else if(data.type === 'chair') { arr = lobby.world.droppedChairs; bagItemType = 'chair'; }
        else if(data.type === 'bolt') { arr = lobby.world.droppedBolts; bagItemType = 'bolt'; }
        else if(data.type === 'sapling') { arr = lobby.world.droppedSaplings; bagItemType = 'sapling'; slotItemType = 'sapling'; }
        else if(data.type === 'bed_item') { arr = lobby.world.droppedBeds; bagItemType = 'bed'; slotItemType = 'bed'; }
        else if(data.type === 'clock_item') { arr = lobby.world.droppedClocks; bagItemType = 'clock'; slotItemType = 'clock'; }
        
        if (arr) {
            const index = arr.findIndex(i => i.id === data.id && !i.collected);
            if(index !== -1) {
                if (data.toBag && p.bag.length < 10 && bagItemType) {
                    arr[index].collected = true; p.bag.push(bagItemType); socket.emit('inventorySync', {bag: p.bag});
                } else if (!data.toBag && slotItemType) {
                    arr[index].collected = true; socket.emit('itemToSlot', slotItemType);
                }
            }
        } else if (data.type === 'placedbed') {
            const idx = lobby.world.beds.findIndex(b => b.id === data.id);
            if(idx !== -1) { lobby.world.beds.splice(idx, 1); if(data.toBag && p.bag.length<10) { p.bag.push('bed'); socket.emit('inventorySync', {bag: p.bag}); } else socket.emit('itemToSlot', 'bed'); }
        } else if (data.type === 'placedclock') {
            const idx = lobby.world.clocks.findIndex(c => c.id === data.id);
            if(idx !== -1) { lobby.world.clocks.splice(idx, 1); if(data.toBag && p.bag.length<10) { p.bag.push('clock'); socket.emit('inventorySync', {bag: p.bag}); } else socket.emit('itemToSlot', 'clock'); }
        }
    });

    socket.on('dropItem', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.hp <= 0) return;

        let dist = 1.0;
        let itemToDrop = data.fromBag && p.bag.length > 0 ? p.bag.pop() : data.type;
        if (data.fromBag) socket.emit('inventorySync', {bag: p.bag});
        
        lobby.world.uidCounter++;
        let dObj = { id: 'item_' + lobby.world.uidCounter, x: p.x - Math.sin(p.ry)*dist, y: 1.5, z: p.z - Math.cos(p.ry)*dist, collected: false };
        
        if(itemToDrop === 'log') lobby.world.droppedLogs.push(dObj); 
        else if (itemToDrop === 'chair') lobby.world.droppedChairs.push(dObj);
        else if (itemToDrop === 'bolt') lobby.world.droppedBolts.push(dObj);
        else if (itemToDrop === 'sapling') lobby.world.droppedSaplings.push(dObj);
        else if (itemToDrop === 'bed') lobby.world.droppedBeds.push(dObj);
        else if (itemToDrop === 'clock') lobby.world.droppedClocks.push(dObj);
    });

    socket.on('kickPlayer', (id) => { if (lobbies[currentLobby] && lobbies[currentLobby].admin === socket.id) { io.to(id).emit('kicked'); handlePlayerLeave({id:id}); }});
    socket.on('disbandLobby', () => { if (lobbies[currentLobby] && lobbies[currentLobby].admin === socket.id) { io.to(currentLobby).emit('lobbyDisbanded'); delete lobbies[currentLobby]; currentLobby=null; io.emit('updateLobbyList', getLobbiesList()); }});
    socket.on('leaveLobby', () => { handlePlayerLeave(socket); });
    socket.on('startGame', () => { if (lobbies[currentLobby] && lobbies[currentLobby].admin === socket.id) { lobbies[currentLobby].isPlaying = true; io.to(currentLobby).emit('gameStarted', {trees: lobbies[currentLobby].world.trees}); io.emit('updateLobbyList', getLobbiesList()); startGameTicker(currentLobby); }});
    socket.on('disconnect', () => { handlePlayerLeave(socket); });

    function handlePlayerLeave(s) {
        if (currentLobby && lobbies[currentLobby]) {
            const lobby = lobbies[currentLobby];
            lobby.players = lobby.players.filter(p => p.id !== s.id);
            if (lobby.players.length === 0) {
                delete lobbies[currentLobby]; 
            } else { 
                io.to(lobby.id).emit('lobbyUpdated', lobby); 
                if (lobby.admin === s.id) lobby.admin = lobby.players[0].id; 
            }
            currentLobby = null; io.emit('updateLobbyList', getLobbiesList());
        }
    }
});

function generateLevel2Map(lobby) {
    lobby.world.mapRadius = 70; // Расширяем до 140x140
    // Доп. деревья
    for (let i = 0; i < 40; i++) {
        let angle = Math.random() * Math.PI * 2;
        let rad = 35 + Math.random() * 25; // от 35 до 60
        lobby.world.uidCounter++;
        lobby.world.trees.push({ id: 'tree_' + lobby.world.uidCounter, x: Number((Math.cos(angle)*rad).toFixed(2)), z: Number((Math.sin(angle)*rad).toFixed(2)), hp: 4, isCut: false, sinkY: 0 });
    }
    // 5 Домов
    for (let i = 0; i < 5; i++) {
        let angle = (Math.PI * 2 / 5) * i + (Math.random() * 0.5);
        let rad = 40 + Math.random() * 15;
        let hX = Number((Math.cos(angle)*rad).toFixed(2));
        let hZ = Number((Math.sin(angle)*rad).toFixed(2));
        lobby.world.uidCounter++;
        lobby.world.houses.push({ id: 'house_' + lobby.world.uidCounter, x: hX, z: hZ });
        
        // Стулья внутри (3 шт)
        for(let c = 0; c < 3; c++) {
            lobby.world.uidCounter++;
            let offX = (Math.random() - 0.5) * 3; let offZ = (Math.random() - 0.5) * 3;
            lobby.world.droppedChairs.push({id: 'chair_' + lobby.world.uidCounter, x: hX + offX, y: 0.5, z: hZ + offZ, collected: false});
        }
        // Болт 30%
        if(Math.random() < 0.3) {
            lobby.world.uidCounter++;
            lobby.world.droppedBolts.push({id: 'bolt_' + lobby.world.uidCounter, x: hX, y: 0.2, z: hZ, collected: false});
        }
    }
}

function startGameTicker(lobbyId) {
    let lastTick = Date.now();
    let tickCounter = 0; let tpsStart = Date.now();
    
    const interval = setInterval(() => {
        const lobby = lobbies[lobbyId];
        if (!lobby || !lobby.isPlaying) return clearInterval(interval);

        const now = Date.now(); const dt = now - lastTick; lastTick = now;
        
        tickCounter++;
        if (now - tpsStart >= 1000) { lobby.world.tps = tickCounter; tickCounter = 0; tpsStart = now; }

        lobby.world.timeProgress += dt;
        const wasNight = lobby.world.isNight;
        lobby.world.isNight = lobby.world.timeProgress >= DAY_NIGHT_DURATION / 2;
        
        if (lobby.world.timeProgress >= DAY_NIGHT_DURATION) { 
            lobby.world.timeProgress -= DAY_NIGHT_DURATION; 
            lobby.world.day += (lobby.world.beds.length > 0) ? 2 : 1; 
        }

        if (now - lobby.world.lastRegenTime >= 5000) {
            lobby.players.forEach(p => { if (p.hp > 0 && p.hp < 100) { p.hp = Math.min(100, p.hp + 5); io.to(p.id).emit('playerDamaged', p.hp); } });
            lobby.world.lastRegenTime = now;
        }

        let cf = lobby.world.campfire;
        let cfRadius = cf.hp > 0 ? 15 + cf.level * 6 : 0; 
        
        if (cf.hp > 0) { cf.hp -= (dt / 1000) * (1 / (cf.level * 0.5)); if (cf.hp < 0) cf.hp = 0; }

        let oldLevel = cf.level;

        // Обработка брошенных предметов (гравитация и костер/переработчик)
        ['droppedLogs', 'droppedChairs', 'droppedBolts'].forEach(arrName => {
            lobby.world[arrName].forEach(item => {
                if (item.y > 0.2) item.y -= 0.15; else item.y = 0.2;
                if (!item.collected) {
                    let dxC = item.x - cf.x; let dzC = item.z - cf.z;
                    if (Math.sqrt(dxC*dxC + dzC*dzC) < 1.8 && item.y < 0.8) {
                        if(arrName === 'droppedLogs') {
                            item.collected = true; cf.hp += Math.max(2, 20 - (cf.level * 3));
                        } else if(arrName === 'droppedChairs') {
                            item.collected = true; cf.hp += Math.max(3, 30 - (cf.level * 4)); // Стул дает x1.5 топлива
                        }
                    }
                    
                    let dxR = item.x - lobby.world.recycler.x; let dzR = item.z - lobby.world.recycler.z;
                    if (!item.collected && Math.sqrt(dxR*dxR + dzR*dzR) < 1.5 && item.y < 0.8) {
                        item.collected = true;
                        if(arrName === 'droppedLogs') lobby.world.workbench.wood += 1;
                        if(arrName === 'droppedChairs') lobby.world.workbench.wood += 3; // Стул дает 3 дерева
                        if(arrName === 'droppedBolts') lobby.world.workbench.iron += 1; // Болт дает 1 железо
                    }
                }
            });
            lobby.world[arrName] = lobby.world[arrName].filter(i => !i.collected);
        });

        // Уровень костра
        if (cf.hp >= 100 && cf.level < 10) { cf.level++; cf.hp -= 100; if(cf.hp===0) cf.hp=1; } else if (cf.hp > 100) cf.hp = 100;
        
        if(oldLevel === 1 && cf.level >= 2) { generateLevel2Map(lobby); }
        
        ['droppedSaplings', 'droppedBeds', 'droppedClocks'].forEach(arrName => {
            lobby.world[arrName].forEach(item => { if (item.y > 0.2) item.y -= 0.15; else item.y = 0.2; });
            lobby.world[arrName] = lobby.world[arrName].filter(i => !i.collected);
        });

        for (let i = lobby.world.saplings.length - 1; i >= 0; i--) {
            let s = lobby.world.saplings[i]; s.timer += dt;
            if (s.stage === 0 && s.timer > 5000) s.stage = 1;
            else if (s.stage === 1 && s.timer > 95000) s.stage = 2; 
            else if (s.stage === 2 && s.timer > 185000) { 
                lobby.world.uidCounter++; const newTree = { id: 'tree_' + lobby.world.uidCounter, x: s.x, z: s.z, hp: 4, isCut: false, sinkY: 0 };
                lobby.world.trees.push(newTree); io.to(lobbyId).emit('treeUpdated', newTree);
                lobby.players.forEach(p => { let d = Math.sqrt(Math.pow(p.x - s.x, 2) + Math.pow(p.z - s.z, 2)); if(d < 1.0) { p.x += 1.5; p.z += 1.5; io.to(p.id).emit('forceMove', {x: p.x, z: p.z}); } });
                lobby.world.saplings.splice(i, 1);
            }
        }

        if(lobby.world.isNight && !wasNight) {
            let spawnCount = 2 + cf.level;
            for(let i=0; i<spawnCount; i++) {
                lobby.world.uidCounter++; let angle = Math.random() * Math.PI * 2;
                lobby.world.wolves.push({ id: 'wolf_' + lobby.world.uidCounter, x: Math.cos(angle) * 30, z: Math.sin(angle) * 30, ry: 0, hp: 100, lastAttack: 0 });
            }
        } else if(!lobby.world.isNight && wasNight) { lobby.world.wolves = []; }

        lobby.world.wolves.forEach((w, index) => {
            lobby.world.wolves.forEach((otherW, jIndex) => {
                if (index !== jIndex) {
                    let ddx = w.x - otherW.x; let ddz = w.z - otherW.z; let ddist = Math.sqrt(ddx*ddx + ddz*ddz);
                    if (ddist > 0.01 && ddist < 0.8) { w.x += (ddx/ddist) * 1.5 * (dt/1000); w.z += (ddz/ddist) * 1.5 * (dt/1000); }
                }
            });

            let closestP = null; let minD = 999;
            lobby.players.forEach(p => { if(p.hp > 0) { let d = Math.sqrt(Math.pow(p.x - w.x, 2) + Math.pow(p.z - w.z, 2)); if(d < minD) { minD = d; closestP = p; } } });

            if(closestP) {
                let dToFireP = Math.sqrt(Math.pow(closestP.x - cf.x, 2) + Math.pow(closestP.z - cf.z, 2));
                let dToFireW = Math.sqrt(Math.pow(w.x - cf.x, 2) + Math.pow(w.z - cf.z, 2));

                if (cf.hp > 0 && dToFireW < cfRadius) {
                    let dx = w.x - cf.x; let dz = w.z - cf.z; let len = Math.sqrt(dx*dx + dz*dz);
                    w.x += (dx/len) * 4.0 * (dt/1000); w.z += (dz/len) * 4.0 * (dt/1000); w.ry = Math.atan2(dx, dz);
                } else if(cf.hp > 0 && dToFireP < cfRadius) {
                    let dx = closestP.x - w.x; let dz = closestP.z - w.z; w.ry = Math.atan2(dx, dz);
                } else {
                    let dx = closestP.x - w.x; let dz = closestP.z - w.z;
                    if(minD > 1.2) {
                        w.x += (dx/minD) * 3.5 * (dt/1000); w.z += (dz/minD) * 3.5 * (dt/1000); w.ry = Math.atan2(dx, dz);
                    } else {
                        if (now - w.lastAttack > 3000) {
                            w.lastAttack = now; closestP.hp -= 15;
                            if(closestP.hp <= 0) { closestP.hp = 0; io.to(lobbyId).emit('chatMessage', `🐺 Волки растерзали ${closestP.name}`); }
                            io.to(closestP.id).emit('playerDamaged', closestP.hp);
                        }
                    }
                }
            }
        });

        // Отправка клиенту только нужной информации
        io.to(lobbyId).emit('worldSync', {
            tps: lobby.world.tps, mapRadius: lobby.world.mapRadius, day: lobby.world.day, isNight: lobby.world.isNight, timeProgress: lobby.world.timeProgress,
            campfire: { hp: Number(lobby.world.campfire.hp.toFixed(1)), level: lobby.world.campfire.level, x:0, z:0 },
            workbench: lobby.world.workbench, beds: lobby.world.beds, houses: lobby.world.houses, clocks: lobby.world.clocks,
            droppedLogs: lobby.world.droppedLogs.map(l => ({ id: l.id, x: Number(l.x.toFixed(2)), y: Number(l.y.toFixed(2)), z: Number(l.z.toFixed(2)) })),
            droppedChairs: lobby.world.droppedChairs.map(c => ({ id: c.id, x: Number(c.x.toFixed(2)), y: Number(c.y.toFixed(2)), z: Number(c.z.toFixed(2)) })),
            droppedBolts: lobby.world.droppedBolts.map(b => ({ id: b.id, x: Number(b.x.toFixed(2)), y: Number(b.y.toFixed(2)), z: Number(b.z.toFixed(2)) })),
            droppedSaplings: lobby.world.droppedSaplings.map(s => ({ id: s.id, x: Number(s.x.toFixed(2)), y: Number(s.y.toFixed(2)), z: Number(s.z.toFixed(2)) })),
            droppedBeds: lobby.world.droppedBeds.map(b => ({ id: b.id, x: Number(b.x.toFixed(2)), y: Number(b.y.toFixed(2)), z: Number(b.z.toFixed(2)) })),
            droppedClocks: lobby.world.droppedClocks.map(c => ({ id: c.id, x: Number(c.x.toFixed(2)), y: Number(c.y.toFixed(2)), z: Number(c.z.toFixed(2)) })),
            saplings: lobby.world.saplings.map(s => ({ id: s.id, x: Number(s.x.toFixed(2)), z: Number(s.z.toFixed(2)), stage: s.stage })),
            wolves: lobby.world.wolves.map(w => ({ id: w.id, x: Number(w.x.toFixed(2)), z: Number(w.z.toFixed(2)), ry: Number(w.ry.toFixed(2)), hp: w.hp }))
        });
        io.to(lobbyId).emit('playersSync', lobby.players.map(p => ({ id: p.id, name: p.name, color: p.color, hp: p.hp, x: Number(p.x.toFixed(2)), z: Number(p.z.toFixed(2)), ry: Number(p.ry.toFixed(2)) })));

    }, TPS_INTERVAL); 
}

function getLobbiesList() { return Object.values(lobbies).filter(l => !l.isPlaying).map(l => ({ id: l.id, name: l.name, hasPassword: !!l.password, playersCount: l.players.length, maxPlayers: l.maxPlayers })); }
const PORT = process.env.PORT || 3000; server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
