import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Configuration depuis les variables d'environnement Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; // Obligatoire pour outrepasser RLS dans un webhook
const monetbilSecret = process.env.MONETBIL_SECRET;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = req.body;

        // 1. Vérification de la signature Monetbil (Optionnel mais recommandé)
        // Note: La documentation Monetbil précise comment vérifier l'authenticité
        // Ici on suppose que Monetbil envoie `sign` dans le body ou les headers selon la configuration.
        // Pour cet exemple, on fait confiance à l'appel POST via HTTPS contenant item_ref et transaction_id.
        // En production, il FAUT utiliser le Service Secret (MONETBIL_SECRET) pour valider selon la doc v2.1.

        console.log('Webhook Monetbil reçu : ', body);

        const transactionId = body.transaction_id;
        const status = body.status; // '1' ou 'success' selon v2 ou v1
        const itemRef = body.item_ref;
        const phone = body.phone;
        const amount = body.amount;

        // Monetbil `payment_result` or similar status check
        if (body.status === 1 || body.status === 'success' || body.message === 'Payment successful') {

            // On s'attend à recevoir des métadonnées dans item_ref ou un champ custom (data)
            // ex: custom_data envoyé côté front via widget.setup(data) ou item_ref formaté
            // Mais pour Monetbil v2 widget, on a peut-être reçu le json custom
            let parsedData = {};
            try {
                if (body.custom) parsedData = JSON.parse(body.custom);
            } catch (e) { console.error('Erreur parsing custom data', e); }

            // Si on ne passe pas par custom, il faut adapter
            // Le front passait les infos via un console.log. Il faudra que le front passe custom: JSON.stringify(...) dans setup

            const motoId = parsedData.motoId || 1; // Fallback
            const qty = parsedData.qty || 1;
            const nomAch = parsedData.nom || 'Client';

            // A. Insérer Paiement
            const { data: paiement, error: errPaiement } = await supabase
                .from('paiements')
                .insert([{
                    reference_paiement: itemRef || `REF-${Date.now()}`,
                    monetbil_transaction_id: transactionId,
                    montant: parseInt(amount),
                    telephone: phone,
                    statut: 'SUCCESS',
                    moto_id: motoId,
                    quantite: qty,
                    acheteur_nom: nomAch
                }])
                .select()
                .single();

            if (errPaiement) {
                console.error("Erreur insertion paiement", errPaiement);
                return res.status(500).json({ error: "DB Error (paiement)" });
            }

            // B. Générer les tickets
            // On compte le nombre de tickets vendus pour cette moto
            const { count: vendus, error: errCount } = await supabase
                .from('tickets')
                .select('*', { count: 'exact', head: true })
                .eq('moto_id', motoId);

            let startVendus = vendus || 0;
            const ticketsToInsert = [];

            for (let i = 0; i < qty; i++) {
                const num = String(startVendus + i + 1).padStart(5, '0');
                ticketsToInsert.push({
                    paiement_id: paiement.id,
                    moto_id: motoId,
                    numero_ticket: num,
                    acheteur_nom: nomAch,
                    acheteur_tel: phone
                });
            }

            const { error: errTickets } = await supabase
                .from('tickets')
                .insert(ticketsToInsert);

            if (errTickets) {
                console.error("Erreur insertion tickets", errTickets);
                return res.status(500).json({ error: "DB Error (tickets)" });
            }

            return res.status(200).json({ status: 'success', message: 'Paiement traité' });
        } else {
            console.log("Paiement échoué ou en attente", body);
            return res.status(200).json({ status: 'ignored', message: 'Statut non success' });
        }
    } catch (error) {
        console.error('Erreur traitement webhook', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
