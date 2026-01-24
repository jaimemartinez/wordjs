/**
 * Seed script to add 100 test participants to the conference manager
 * Run with: node backend/scripts/seed-conference-participants.js
 */

const path = require('path');

// Get backend directory (where src/config/database.js is located)
const backendDir = path.resolve(__dirname, '..');

// Change to backend directory before requiring modules
process.chdir(backendDir);

// Now require from backend directory using absolute path
const { dbAsync, init, initializeDatabase } = require(path.join(backendDir, 'src/config/database'));

// Sample data for generating realistic participants
const firstNames = [
    'Juan', 'María', 'Carlos', 'Ana', 'Luis', 'Laura', 'Pedro', 'Carmen', 'Jorge', 'Patricia',
    'Miguel', 'Sandra', 'Roberto', 'Mónica', 'Fernando', 'Andrea', 'Ricardo', 'Diana', 'Andrés', 'Claudia',
    'Diego', 'Paola', 'Alejandro', 'Natalia', 'Daniel', 'Valentina', 'Sergio', 'Camila', 'Javier', 'Isabella',
    'Gustavo', 'Mariana', 'Felipe', 'Sofía', 'Rodrigo', 'Daniela', 'Sebastián', 'Alejandra', 'Cristian', 'Juliana',
    'Manuel', 'Carolina', 'Eduardo', 'Gabriela', 'Héctor', 'Liliana', 'Óscar', 'Adriana', 'Pablo', 'Lucía'
];

const lastNames = [
    'García', 'Rodríguez', 'González', 'Fernández', 'López', 'Martínez', 'Sánchez', 'Pérez', 'Gómez', 'Martín',
    'Jiménez', 'Ruiz', 'Hernández', 'Díaz', 'Moreno', 'Álvarez', 'Muñoz', 'Romero', 'Alonso', 'Gutiérrez',
    'Navarro', 'Torres', 'Domínguez', 'Vázquez', 'Ramos', 'Gil', 'Ramírez', 'Serrano', 'Blanco', 'Suárez',
    'Molina', 'Morales', 'Ortega', 'Delgado', 'Castro', 'Ortiz', 'Rubio', 'Marín', 'Sanz', 'Iglesias',
    'Nuñez', 'Medina', 'Garrido', 'Cortés', 'Castillo', 'Santos', 'Lozano', 'Guerrero', 'Cano', 'Prieto'
];

const locations = [
    'Bogotá, Cundinamarca, Colombia',
    'Medellín, Antioquia, Colombia',
    'Cali, Valle del Cauca, Colombia',
    'Barranquilla, Atlántico, Colombia',
    'Cartagena, Bolívar, Colombia',
    'Bucaramanga, Santander, Colombia',
    'Pereira, Risaralda, Colombia',
    'Santa Marta, Magdalena, Colombia',
    'Manizales, Caldas, Colombia',
    'Armenia, Quindío, Colombia',
    'Villavicencio, Meta, Colombia',
    'Pasto, Nariño, Colombia',
    'Ibagué, Tolima, Colombia',
    'Neiva, Huila, Colombia',
    'Valledupar, Cesar, Colombia'
];

const documentTypes = ['Cédula', 'Tarjeta de Identidad', 'Pasaporte', 'Cédula de Extranjería'];
const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const epsList = [
    'Sura', 'Nueva EPS', 'Sanitas', 'Coomeva', 'Salud Total', 'Famisanar', 'Compensar', 
    'Cruz Blanca', 'Medimás', 'Aliansalud', 'Saviasalud', 'Emssanar'
];

const paymentStatuses = ['paid', 'partial', 'unpaid'];
const familyGroups = ['Familia García', 'Familia Rodríguez', 'Familia López', 'Familia Martínez', null, null, null];

function randomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateEmail(firstName, lastName) {
    const domains = ['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'colombia.com'];
    const num = randomInt(1, 999);
    return `${firstName.toLowerCase()}.${lastName.toLowerCase()}${num}@${randomElement(domains)}`;
}

function generatePhone() {
    return `+57 ${randomInt(300, 399)} ${randomInt(100, 999)} ${randomInt(1000, 9999)}`;
}

function generateDocumentNumber() {
    return `${randomInt(10000000, 99999999)}`;
}

async function seedParticipants() {
    try {
        console.log('🌱 Starting to seed 100 participants...');
        
        // Get the first conference (or create one if none exists)
        let conference = await dbAsync.get('SELECT id FROM conferences LIMIT 1');
        
        if (!conference) {
            console.log('📝 No conference found, creating default conference...');
            const result = await dbAsync.run(
                "INSERT INTO conferences (name, slug, status, description) VALUES (?, ?, ?, ?)",
                ['Default Conference', 'default-conf', 'active', 'Default conference for testing']
            );
            conference = { id: result.lastID };
        }
        
        const conferenceId = conference.id;
        console.log(`✅ Using conference ID: ${conferenceId}`);
        
        // Generate and insert 100 participants
        const participants = [];
        for (let i = 0; i < 100; i++) {
            const firstName = randomElement(firstNames);
            const lastName = randomElement(lastNames);
            const gender = randomElement(['M', 'F']);
            const age = randomInt(18, 75);
            const location = randomElement(locations);
            const documentType = randomElement(documentTypes);
            const documentNumber = generateDocumentNumber();
            const bloodType = randomElement(bloodTypes);
            const eps = randomElement(epsList);
            const familyGroup = randomElement(familyGroups);
            const paymentStatus = randomElement(paymentStatuses);
            const totalDue = randomInt(50, 500);
            const amountPaid = paymentStatus === 'paid' ? totalDue : 
                              paymentStatus === 'partial' ? randomInt(1, totalDue - 1) : 0;
            
            participants.push({
                conference_id: conferenceId,
                first_name: firstName,
                last_name: lastName,
                gender: gender,
                email: generateEmail(firstName, lastName),
                phone: generatePhone(),
                age: age,
                location: location,
                document_type: documentType,
                document_number: documentNumber,
                blood_type: bloodType,
                eps: eps,
                family_group: familyGroup,
                total_due: totalDue,
                amount_paid: amountPaid,
                payment_status: paymentStatus,
                status: 'confirmed'
            });
        }
        
        // Insert participants in batches
        console.log('📥 Inserting participants...');
        let inserted = 0;
        for (const participant of participants) {
            try {
                await dbAsync.run(
                    `INSERT INTO conference_inscriptions 
                    (conference_id, first_name, last_name, gender, email, phone, age, location, 
                     document_type, document_number, blood_type, eps, family_group, 
                     total_due, amount_paid, payment_status, status) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        participant.conference_id,
                        participant.first_name,
                        participant.last_name,
                        participant.gender,
                        participant.email,
                        participant.phone,
                        participant.age,
                        participant.location,
                        participant.document_type,
                        participant.document_number,
                        participant.blood_type,
                        participant.eps,
                        participant.family_group,
                        participant.total_due,
                        participant.amount_paid,
                        participant.payment_status,
                        participant.status
                    ]
                );
                inserted++;
                if (inserted % 10 === 0) {
                    process.stdout.write(`\r   Progress: ${inserted}/100 participants inserted...`);
                }
            } catch (error) {
                console.error(`\n❌ Error inserting participant ${participant.first_name} ${participant.last_name}:`, error.message);
            }
        }
        
        console.log(`\n✅ Successfully inserted ${inserted} participants!`);
        console.log(`📊 Conference ID: ${conferenceId}`);
        
        // Show statistics
        const stats = await dbAsync.get(
            'SELECT COUNT(*) as total, COUNT(DISTINCT location) as locations FROM conference_inscriptions WHERE conference_id = ?',
            [conferenceId]
        );
        console.log(`\n📈 Statistics:`);
        console.log(`   Total participants: ${stats.total}`);
        console.log(`   Unique locations: ${stats.locations}`);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error seeding participants:', error);
        process.exit(1);
    }
}

// Initialize database connection and run seed
(async () => {
    try {
        console.log('🔌 Initializing database connection...');
        await init();
        await initializeDatabase();
        
        // Initialize plugin schema
        const pluginPath = path.join(backendDir, 'plugins', 'conference-manager', 'index.js');
        const pluginInit = require(pluginPath);
        await pluginInit.init();
        
        console.log('✅ Database initialized\n');
        await seedParticipants();
    } catch (error) {
        console.error('❌ Error initializing:', error);
        process.exit(1);
    }
})();
