// The checkout page's card field. Stripe's own script draws it, so card numbers go straight
// to Stripe and never reach the shop. On submit, it swaps the card for a one-time token,
// puts that in the form's hidden `paymentToken` field, and only then lets the form post.

const mount = document.getElementById("card-element");
const stripe = Stripe(mount.dataset.stripeKey);
const card = stripe.elements().create("card");
card.mount(mount);

const form = mount.closest("form");
form.addEventListener("submit", async (event) => {
	if (document.getElementById("payment-token").value !== "") {
		return;
	}
	event.preventDefault();
	const { token, error } = await stripe.createToken(card);
	if (error) {
		mount.setAttribute("aria-invalid", "true");
		mount.title = error.message;
		return;
	}
	document.getElementById("payment-token").value = token.id;
	form.submit();
});
